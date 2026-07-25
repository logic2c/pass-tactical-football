import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { RoomManager } from "./room-manager";
import { GameRunner } from "./game-runner";
import { reconnectPlayer, setPlayerDisconnected, transferHost, toRoomState, chooseSlot, toggleReady, startGame } from "./room";
import type { Room } from "./room";

const PORT = parseInt(process.env.PORT || "8080", 10);
const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 60_000;

const rooms = new RoomManager();

function broadcast(room: Room) {
  const state = toRoomState(room);
  const message = JSON.stringify({
    type: "room-state",
    revision: room.revision,
    payload: state,
  });

  room.connections.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  });
}

const gameRunner = new GameRunner(broadcast);

function sendError(ws: WebSocket, code: string, message: string) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: "error", revision: 0, payload: { code, message } }));
  }
}

/** Resolve playerId by looking up the WebSocket in the room's connections. */
function resolvePlayerId(roomCode: string, ws: WebSocket, fallbackPlayerId: string): string {
  if (fallbackPlayerId) return fallbackPlayerId;
  const room = rooms.get(roomCode);
  if (!room) return fallbackPlayerId;
  for (const [pid, conn] of room.connections) {
    if (conn === ws) return pid;
  }
  return fallbackPlayerId;
}

function handleMessage(ws: WebSocket, raw: string, playerId: string, roomCode: string) {
  let envelope: { type: string; payload?: any };
  try {
    envelope = JSON.parse(raw);
  } catch {
    sendError(ws, "INVALID_JSON", "无法解析消息。");
    return;
  }

  const { type, payload = {} } = envelope;

  switch (type) {
    case "create-room": {
      const mode = payload.mode === "4v4" ? "4v4" : "3v3";
      const displayName = String(payload.displayName || "Player").slice(0, 20);
      const { room, playerId: newId } = rooms.create(mode, displayName);
      // Update the connection association
      ws.send(JSON.stringify({
        type: "welcome",
        revision: 0,
        payload: { playerId: newId, roomCode: room.roomCode },
      }));
      room.connections.set(newId, ws);
      broadcast(room);
      break;
    }

    case "join-room": {
      const code = String(payload.roomCode || "").toUpperCase();
      const displayName = String(payload.displayName || "Player").slice(0, 20);
      const existingPlayerId = payload.playerId || undefined;

      const result = rooms.join(code, existingPlayerId, displayName);
      if ("error" in result) {
        sendError(ws, result.error, result.error === "ROOM_NOT_FOUND" ? "房间不存在。" : "加入失败。");
        return;
      }

      const room = rooms.get(code)!;
      ws.send(JSON.stringify({
        type: "welcome",
        revision: room.revision,
        payload: { playerId: result.slot.playerId, roomCode: code },
      }));

      if (result.isReconnect) {
        reconnectPlayer(room, result.slot.playerId, ws);
      } else {
        room.connections.set(result.slot.playerId, ws);
      }

      broadcast(room);
      break;
    }

    case "choose-slot": {
      const room = rooms.get(roomCode);
      if (!room) { sendError(ws, "ROOM_NOT_FOUND", "房间不存在。"); return; }
      const pid = resolvePlayerId(roomCode, ws, playerId);
      if (!chooseSlot(room, pid, payload.positionId)) {
        sendError(ws, "SLOT_TAKEN", "该位置已被占用。");
        return;
      }
      broadcast(room);
      break;
    }

    case "toggle-ready": {
      const room = rooms.get(roomCode);
      if (!room) { sendError(ws, "ROOM_NOT_FOUND", "房间不存在。"); return; }
      const pid = resolvePlayerId(roomCode, ws, playerId);
      toggleReady(room, pid);
      broadcast(room);
      break;
    }

    case "start-game": {
      const room = rooms.get(roomCode);
      if (!room) { sendError(ws, "ROOM_NOT_FOUND", "房间不存在。"); return; }
      const pid = resolvePlayerId(roomCode, ws, playerId);
      const slot = room.slots.find((s) => s.playerId === pid);
      if (!slot?.isHost) { sendError(ws, "NOT_HOST", "只有房主可以开始游戏。"); return; }
      if (!startGame(room)) { sendError(ws, "NOT_READY", "所有玩家必须准备就绪。"); return; }
      gameRunner.startGame(room);
      break;
    }

    case "game-command": {
      const room = rooms.get(roomCode);
      if (!room) { sendError(ws, "ROOM_NOT_FOUND", "房间不存在。"); return; }
      const pid = resolvePlayerId(roomCode, ws, playerId);
      const result = gameRunner.processCommand(room, pid, payload);
      if (!result.ok) {
        sendError(ws, result.error || "INVALID_ACTION", "无法执行此操作。");
        return;
      }
      broadcast(room);
      break;
    }

    case "leave-room": {
      const room = rooms.get(roomCode);
      if (room) {
        const pid = resolvePlayerId(roomCode, ws, playerId);
        setPlayerDisconnected(room, pid);
        transferHost(room);
        broadcast(room);
      }
      break;
    }

    case "ping": {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "pong", revision: 0, payload: {} }));
      }
      break;
    }

    default:
      sendError(ws, "UNKNOWN_TYPE", `未知消息类型: ${type}`);
  }
}

export function createServer() {
  const wss = new WebSocketServer({ port: PORT });

  console.log(`[PASS Server] WebSocket server listening on ws://localhost:${PORT}`);

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    let playerId = "";
    let roomCode = "";
    let alive = true;

    // Heartbeat
    const heartbeatTimer = setInterval(() => {
      if (!alive) {
        clearInterval(heartbeatTimer);
        return ws.terminate();
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL);

    ws.on("pong", () => { alive = true; });

    ws.on("message", (data: Buffer) => {
      const raw = data.toString();
      try {
        // For the first message, extract playerId/roomCode from payload
        const envelope = JSON.parse(raw);
        if (envelope.payload) {
          if (envelope.payload.roomCode) roomCode = envelope.payload.roomCode;
          if (envelope.payload.playerId) playerId = envelope.payload.playerId;
        }
      } catch { /* parse error handled in handleMessage */ }

      handleMessage(ws, raw, playerId, roomCode);
    });

    ws.on("close", () => {
      clearInterval(heartbeatTimer);
      if (roomCode) {
        const room = rooms.get(roomCode);
        if (room) {
          const pid = resolvePlayerId(roomCode, ws, playerId);
          if (pid) {
            setPlayerDisconnected(room, pid);
            transferHost(room);
            broadcast(room);
          }
        }
      }
    });

    ws.on("error", () => {
      clearInterval(heartbeatTimer);
    });
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("[PASS Server] Shutting down...");
    rooms.shutdown();
    wss.close();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("[PASS Server] Shutting down...");
    rooms.shutdown();
    wss.close();
    process.exit(0);
  });

  return wss;
}
