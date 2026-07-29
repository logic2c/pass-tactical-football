import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { GameAction, RoomMode } from "../shared/types";
import { RoomManager } from "./room-manager";
import { GameRunner } from "./game-runner";
import { reconnectPlayer, setPlayerDisconnected, transferHost, toRoomState, chooseSlot, toggleReady, startGame } from "./room";
import type { Room } from "./room";

const PORT = parseInt(process.env.PORT || "8080", 10);
const HOST = process.env.HOST || "0.0.0.0";
const HEARTBEAT_INTERVAL = 30_000;

const rooms = new RoomManager();

function broadcast(room: Room) {
  room.connections.forEach((ws, playerId) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: "room-state",
        revision: room.revision,
        payload: toRoomState(room, playerId),
      }));
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
function resolvePlayerId(roomCode: string, ws: WebSocket): string {
  const room = rooms.get(roomCode);
  if (!room) return "";
  for (const [pid, conn] of room.connections) {
    if (conn === ws) return pid;
  }
  return "";
}

function handleMessage(ws: WebSocket, raw: string, roomCode: string): { roomCode?: string } | void {
  let envelope: { type: string; payload?: Record<string, unknown> };
  try {
    envelope = JSON.parse(raw);
  } catch {
    sendError(ws, "INVALID_JSON", "无法解析消息。");
    return;
  }

  const { type, payload = {} } = envelope;

  switch (type) {
    case "create-room": {
      const supportedModes: RoomMode[] = ["1v1", "2v2", "3v3", "4v4", "3v3-duel", "4v4-duo"];
      const requestedMode = String(payload.mode || "3v3");
      const mode: RoomMode = supportedModes.includes(requestedMode as RoomMode) ? requestedMode as RoomMode : "3v3";
      const displayName = String(payload.displayName || "Player").slice(0, 20);
      const { room, playerId: newId, reconnectToken } = rooms.create(mode, displayName);
      // Update the connection association
      ws.send(JSON.stringify({
        type: "welcome",
        revision: 0,
        payload: { playerId: newId, roomCode: room.roomCode, reconnectToken },
      }));
      room.connections.set(newId, ws);
      broadcast(room);
      return { roomCode: room.roomCode };
    }

    case "join-room": {
      const code = String(payload.roomCode || "").toUpperCase();
      const displayName = String(payload.displayName || "Player").slice(0, 20);
      const reconnectToken = typeof payload.reconnectToken === "string" ? payload.reconnectToken : undefined;

      const result = rooms.join(code, reconnectToken, displayName);
      if ("error" in result) {
        sendError(ws, result.error, result.error === "ROOM_NOT_FOUND" ? "房间不存在。" : result.error === "INVALID_RECONNECT_TOKEN" ? "重连凭证已失效，请重新加入房间。" : "加入失败。");
        return;
      }

      const room = rooms.get(code)!;
      ws.send(JSON.stringify({
        type: "welcome",
        revision: room.revision,
        payload: { playerId: result.slot.playerId, roomCode: code, reconnectToken: result.reconnectToken },
      }));

      if (result.isReconnect) {
        reconnectPlayer(room, result.slot.playerId, ws);
      } else {
        room.connections.set(result.slot.playerId, ws);
      }

      broadcast(room);
      return { roomCode: code };
    }

    case "choose-slot": {
      const room = rooms.get(roomCode);
      if (!room) { sendError(ws, "ROOM_NOT_FOUND", "房间不存在。"); return; }
      const pid = resolvePlayerId(roomCode, ws);
      if (!chooseSlot(room, pid, String(payload.positionId || ""))) {
        sendError(ws, "SLOT_TAKEN", "该位置已被占用。");
        return;
      }
      broadcast(room);
      break;
    }

    case "toggle-ready": {
      const room = rooms.get(roomCode);
      if (!room) { sendError(ws, "ROOM_NOT_FOUND", "房间不存在。"); return; }
      const pid = resolvePlayerId(roomCode, ws);
      toggleReady(room, pid);
      broadcast(room);
      break;
    }

    case "start-game": {
      const room = rooms.get(roomCode);
      if (!room) { sendError(ws, "ROOM_NOT_FOUND", "房间不存在。"); return; }
      const pid = resolvePlayerId(roomCode, ws);
      const slot = room.slots.find((s) => s.playerId === pid);
      if (!slot?.isHost) { sendError(ws, "NOT_HOST", "只有房主可以开始游戏。"); return; }
      if (!startGame(room)) { sendError(ws, "NOT_READY", "所有玩家必须准备就绪。"); return; }
      gameRunner.startGame(room);
      break;
    }

    case "game-command": {
      const room = rooms.get(roomCode);
      if (!room) { sendError(ws, "ROOM_NOT_FOUND", "房间不存在。"); return; }
      const pid = resolvePlayerId(roomCode, ws);
      const result = gameRunner.processCommand(room, pid, payload as unknown as GameAction);
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
        const pid = resolvePlayerId(roomCode, ws);
        setPlayerDisconnected(room, pid, ws);
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
  const wss = new WebSocketServer({ port: PORT, host: HOST });

  console.log(`[PASS Server] WebSocket server listening on ws://${HOST}:${PORT}`);

  wss.on("connection", (ws: WebSocket) => {
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
      const result = handleMessage(ws, raw, roomCode);
      if (result) {
        if (result.roomCode) roomCode = result.roomCode;
      }
    });

    ws.on("close", () => {
      clearInterval(heartbeatTimer);
      if (roomCode) {
        const room = rooms.get(roomCode);
        if (room) {
          const pid = resolvePlayerId(roomCode, ws);
          if (pid) {
            setPlayerDisconnected(room, pid, ws);
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
