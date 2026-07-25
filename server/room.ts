import { v4 as uuid } from "uuid";
import type { WebSocket } from "ws";
import type { GameState, PlayerSlot, RoomState } from "../shared/types";

// Clean alphabet without ambiguous chars: I/L/O/0/1
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export function generatePlayerId(): string {
  return uuid();
}

export type SlotMap = Map<string, PlayerSlot>; // playerId → slot

export interface Room {
  roomCode: string;
  status: "lobby" | "playing" | "finished";
  slots: PlayerSlot[];
  gameMode: "3v3" | "4v4";
  playerSlotsPerTeam: 3 | 4;
  createdAt: number;
  gameState?: GameState;
  winner?: "red" | "blue";
  // Internal: WebSocket connections map
  connections: Map<string, WebSocket>; // playerId → ws
  revision: number;
}

export function createRoom(mode: "3v3" | "4v4", displayName: string): { room: Room; playerId: string } {
  const playerId = generatePlayerId();
  const slotsPerTeam = mode === "4v4" ? 4 : 3;

  const room: Room = {
    roomCode: generateRoomCode(),
    status: "lobby",
    slots: [
      {
        playerId,
        displayName,
        positionId: null,
        team: null,
        isHost: true,
        isReady: false,
        isConnected: true,
        isSpectator: false,
      },
    ],
    gameMode: mode,
    playerSlotsPerTeam: slotsPerTeam,
    createdAt: Date.now(),
    connections: new Map(),
    revision: 0,
  };

  return { room, playerId };
}

export function getAvailablePositions(room: Room): { red: string[]; blue: string[] } {
  const max = room.playerSlotsPerTeam;
  const redPositions = Array.from({ length: max }, (_, i) => `r${i + 1}`);
  const bluePositions = Array.from({ length: max }, (_, i) => `b${i + 1}`);
  const taken = new Set(room.slots.filter((s) => s.positionId && !s.isSpectator).map((s) => s.positionId));
  return {
    red: redPositions.filter((p) => !taken.has(p)),
    blue: bluePositions.filter((p) => !taken.has(p)),
  };
}

export function findSlot(room: Room, playerId: string): PlayerSlot | undefined {
  return room.slots.find((s) => s.playerId === playerId);
}

export function joinRoom(room: Room, playerId: string | undefined, displayName: string): { slot: PlayerSlot; isReconnect: boolean } {
  // Check if player is reconnecting
  if (playerId) {
    const existing = findSlot(room, playerId);
    if (existing) {
      existing.isConnected = true;
      return { slot: existing, isReconnect: true };
    }
  }

  // If game is playing, join as spectator
  if (room.status === "playing") {
    const slot: PlayerSlot = {
      playerId: generatePlayerId(),
      displayName,
      positionId: null,
      team: null,
      isHost: false,
      isReady: false,
      isConnected: true,
      isSpectator: true,
    };
    room.slots.push(slot);
    return { slot, isReconnect: false };
  }

  // Check if lobby has open non-spectator positions
  const available = getAvailablePositions(room);
  const totalAvailable = available.red.length + available.blue.length;

  const newId = generatePlayerId();
  const slot: PlayerSlot = {
    playerId: newId,
    displayName,
    positionId: null,
    team: null,
    isHost: false,
    isReady: false,
    isConnected: true,
    isSpectator: totalAvailable === 0, // Spectator if lobby is full
  };
  room.slots.push(slot);
  return { slot, isReconnect: false };
}

export function chooseSlot(room: Room, playerId: string, positionId: string): boolean {
  const slot = findSlot(room, playerId);
  if (!slot || slot.isSpectator || room.status !== "lobby") return false;

  // Check if position is available
  const available = getAvailablePositions(room);
  const allAvailable = [...available.red, ...available.blue];
  if (!allAvailable.includes(positionId)) return false;

  // If slot already had a position, release it first (implicit)
  slot.positionId = positionId;
  slot.team = positionId.startsWith("r") ? "red" : "blue";
  return true;
}

export function toggleReady(room: Room, playerId: string): boolean {
  const slot = findSlot(room, playerId);
  if (!slot || slot.isSpectator || room.status !== "lobby") return false;
  slot.isReady = !slot.isReady;
  return true;
}

export function allPlayersReady(room: Room): boolean {
  const activeSlots = room.slots.filter((s) => !s.isSpectator);
  return activeSlots.length >= 2 && activeSlots.every((s) => s.isReady);
}

export function startGame(room: Room): boolean {
  if (room.status !== "lobby") return false;
  if (!allPlayersReady(room)) return false;

  // Assign positions to any unassigned active slots (from remaining available)
  const available = getAvailablePositions(room);
  const allAvailable = [...available.red, ...available.blue];
  const unassigned = room.slots.filter((s) => !s.isSpectator && !s.positionId);

  unassigned.forEach((slot, i) => {
    if (i < allAvailable.length) {
      slot.positionId = allAvailable[i];
      slot.team = allAvailable[i].startsWith("r") ? "red" : "blue";
    }
  });

  room.status = "playing";
  return true;
}

export function setPlayerDisconnected(room: Room, playerId: string) {
  const slot = findSlot(room, playerId);
  if (slot) {
    slot.isConnected = false;
    room.connections.delete(playerId);
  }
}

export function reconnectPlayer(room: Room, playerId: string, ws: WebSocket): PlayerSlot | undefined {
  const slot = findSlot(room, playerId);
  if (!slot) return undefined;
  slot.isConnected = true;
  // Close old connection if exists
  const old = room.connections.get(playerId);
  if (old && old !== ws) {
    try { old.close(4001, "replaced"); } catch { /* ignore */ }
  }
  room.connections.set(playerId, ws);
  return slot;
}

export function transferHost(room: Room) {
  const host = room.slots.find((s) => s.isHost);
  if (host?.isConnected) return;
  // Find next connected non-spectator
  const next = room.slots.find((s) => !s.isSpectator && s.isConnected && !s.isHost);
  if (next) {
    if (host) host.isHost = false;
    next.isHost = true;
  }
}

export function allDisconnected(room: Room): boolean {
  return room.slots.filter((s) => !s.isSpectator).every((s) => !s.isConnected);
}

export function cleanupRoom(room: Room): boolean {
  // Returns true if room should be removed
  if (room.status === "finished") {
    return Date.now() - room.createdAt > 5 * 60 * 1000; // 5 min after game ends
  }
  if (allDisconnected(room)) {
    return Date.now() - room.createdAt > 10 * 60 * 1000; // 10 min after all disconnect
  }
  return false;
}

export function toRoomState(room: Room): RoomState {
  return {
    roomCode: room.roomCode,
    status: room.status,
    slots: room.slots.map((s) => ({ ...s })), // shallow clone
    gameMode: room.gameMode,
    playerSlotsPerTeam: room.playerSlotsPerTeam,
    createdAt: room.createdAt,
    gameState: room.gameState,
    winner: room.winner,
  };
}
