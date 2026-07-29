import { v4 as uuid } from "uuid";
import type { WebSocket } from "ws";
import type { BoardMode, GameState, PlayerSlot, RoomMode, RoomState, Team } from "../shared/types";

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
  gameMode: RoomMode;
  boardMode: BoardMode;
  playerSlotsPerTeam: 1 | 2 | 3 | 4;
  createdAt: number;
  lastActivityAt: number;
  allDisconnectedAt?: number;
  finishedAt?: number;
  gameState?: GameState;
  winner?: "red" | "blue";
  // Internal: WebSocket connections map
  connections: Map<string, WebSocket>; // playerId → ws
  reconnectTokens: Map<string, string>; // private token → playerId
  revision: number;
}

export function boardModeForRoom(mode: RoomMode): BoardMode {
  if (mode === "3v3-duel") return "3v3";
  if (mode === "4v4-duo") return "4v4";
  return mode;
}

export function controllerSeatsPerTeam(mode: RoomMode): 1 | 2 | 3 | 4 {
  if (mode === "3v3-duel") return 1;
  if (mode === "4v4-duo") return 2;
  return mode === "4v4" ? 4 : mode === "3v3" ? 3 : mode === "2v2" ? 2 : 1;
}

export function controlGroup(mode: RoomMode, team: Team, seatIndex: number): string[] {
  const prefix = team === "red" ? "r" : "b";
  if (mode === "3v3-duel") return [`${prefix}1`, `${prefix}2`, `${prefix}3`];
  if (mode === "4v4-duo") return seatIndex === 0
    ? [`${prefix}1`, `${prefix}3`]
    : [`${prefix}2`, `${prefix}4`];
  return [`${prefix}${seatIndex + 1}`];
}

export function controlledPositionIds(slot: PlayerSlot): string[] {
  return slot.positionIds.length > 0 ? slot.positionIds : slot.positionId ? [slot.positionId] : [];
}

export function slotControls(slot: PlayerSlot, actorId: string) {
  return controlledPositionIds(slot).includes(actorId);
}

export function createRoom(mode: RoomMode, displayName: string): { room: Room; playerId: string; reconnectToken: string } {
  const playerId = generatePlayerId();
  const reconnectToken = generatePlayerId();
  const slotsPerTeam = controllerSeatsPerTeam(mode);

  const room: Room = {
    roomCode: generateRoomCode(),
    status: "lobby",
    slots: [
      {
        playerId,
        displayName,
        positionId: null,
        positionIds: [],
        team: null,
        isHost: true,
        isReady: false,
        isConnected: true,
        isSpectator: false,
      },
    ],
    gameMode: mode,
    boardMode: boardModeForRoom(mode),
    playerSlotsPerTeam: slotsPerTeam,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    connections: new Map(),
    reconnectTokens: new Map([[reconnectToken, playerId]]),
    revision: 0,
  };

  return { room, playerId, reconnectToken };
}

export function getAvailablePositions(room: Room): { red: string[]; blue: string[] } {
  const max = room.playerSlotsPerTeam;
  const redPositions = Array.from({ length: max }, (_, i) => `r${i + 1}`);
  const bluePositions = Array.from({ length: max }, (_, i) => `b${i + 1}`);
  const taken = new Set(room.slots.filter((s) => !s.isSpectator).map((s) => s.positionId).filter(Boolean));
  return {
    red: redPositions.filter((p) => !taken.has(p)),
    blue: bluePositions.filter((p) => !taken.has(p)),
  };
}

export function findSlot(room: Room, playerId: string): PlayerSlot | undefined {
  return room.slots.find((s) => s.playerId === playerId);
}

export function joinRoom(room: Room, reconnectToken: string | undefined, displayName: string): { slot: PlayerSlot; isReconnect: boolean; reconnectToken: string } {
  // Check if player is reconnecting
  if (reconnectToken) {
    const existingPlayerId = room.reconnectTokens.get(reconnectToken);
    const existing = existingPlayerId ? findSlot(room, existingPlayerId) : undefined;
    if (existing) {
      existing.isConnected = true;
      room.allDisconnectedAt = undefined;
      room.lastActivityAt = Date.now();
      return { slot: existing, isReconnect: true, reconnectToken };
    }
  }

  // If game is playing, join as spectator
  if (room.status === "playing") {
    const slot: PlayerSlot = {
      playerId: generatePlayerId(),
      displayName,
      positionId: null,
      positionIds: [],
      team: null,
      isHost: false,
      isReady: false,
      isConnected: true,
      isSpectator: true,
    };
    const newToken = generatePlayerId();
    room.slots.push(slot);
    room.reconnectTokens.set(newToken, slot.playerId);
    room.lastActivityAt = Date.now();
    return { slot, isReconnect: false, reconnectToken: newToken };
  }

  // Capacity is based on player seats, including players who have not picked a position yet.
  const activeCount = room.slots.filter((slot) => !slot.isSpectator).length;
  const maxPlayers = room.playerSlotsPerTeam * 2;

  const newId = generatePlayerId();
  const slot: PlayerSlot = {
    playerId: newId,
    displayName,
    positionId: null,
    positionIds: [],
    team: null,
    isHost: false,
    isReady: false,
    isConnected: true,
    isSpectator: activeCount >= maxPlayers,
  };
  const newToken = generatePlayerId();
  room.slots.push(slot);
  room.reconnectTokens.set(newToken, slot.playerId);
  room.lastActivityAt = Date.now();
  return { slot, isReconnect: false, reconnectToken: newToken };
}

export function chooseSlot(room: Room, playerId: string, positionId: string): boolean {
  const slot = findSlot(room, playerId);
  if (!slot || slot.isSpectator || room.status !== "lobby") return false;

  // Check if position is available
  const available = getAvailablePositions(room);
  const allAvailable = [...available.red, ...available.blue];
  if (!allAvailable.includes(positionId)) return false;

  // If slot already had a position, release it first (implicit)
  const team = positionId.startsWith("r") ? "red" : "blue";
  const seatIndex = Number(positionId.slice(1)) - 1;
  slot.positionId = positionId;
  slot.positionIds = controlGroup(room.gameMode, team, seatIndex);
  slot.team = team;
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
  const requiredPlayers = room.gameMode === "3v3-duel" || room.gameMode === "4v4-duo"
    ? room.playerSlotsPerTeam * 2
    : 2;
  return activeSlots.length >= requiredPlayers && activeSlots.every((s) => s.isReady);
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
      slot.positionIds = controlGroup(room.gameMode, slot.team, Number(allAvailable[i].slice(1)) - 1);
    }
  });

  room.status = "playing";
  return true;
}

export function setPlayerDisconnected(room: Room, playerId: string, connection?: WebSocket) {
  const slot = findSlot(room, playerId);
  const currentConnection = room.connections.get(playerId);
  // A replaced socket may close after the new one is already installed. Ignore that stale close.
  if (slot && (!connection || currentConnection === connection)) {
    slot.isConnected = false;
    room.connections.delete(playerId);
    room.lastActivityAt = Date.now();
    if (allDisconnected(room)) room.allDisconnectedAt ??= Date.now();
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
  room.allDisconnectedAt = undefined;
  room.lastActivityAt = Date.now();
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
    return Boolean(room.finishedAt && Date.now() - room.finishedAt > 5 * 60 * 1000);
  }
  if (allDisconnected(room)) {
    return Boolean(room.allDisconnectedAt && Date.now() - room.allDisconnectedAt > 10 * 60 * 1000);
  }
  return false;
}

export function toRoomState(room: Room, viewerPlayerId?: string): RoomState {
  const gameState = room.gameState ? structuredClone(room.gameState) : undefined;
  if (gameState) {
    const viewerSlot = findSlot(room, viewerPlayerId ?? "");
    const visiblePlayers = new Set(viewerSlot ? controlledPositionIds(viewerSlot) : []);
    gameState.players.forEach((player) => {
      if (visiblePlayers.has(player.id)) return;
      const hasFootball = player.hand.some((card) => card.kind === "ball");
      const hiddenCount = player.hand.length - (hasFootball ? 1 : 0);
      player.hand = [
        ...Array.from({ length: hiddenCount }, (_, index) => ({
          id: `hidden-${player.id}-${index}`,
          kind: "action" as const,
          suit: "rock" as const,
          cost: 1,
        })),
        ...(hasFootball ? [{ id: "football" as const, kind: "ball" as const }] : []),
      ];
    });
    gameState.deck = gameState.deck.map((_, index) => ({
      id: `hidden-deck-${index}`,
      kind: "action" as const,
      suit: "rock" as const,
      cost: 1,
    }));
  }
  return {
    roomCode: room.roomCode,
    status: room.status,
    slots: room.slots.map((s) => ({ ...s })), // shallow clone
    gameMode: room.gameMode,
    boardMode: room.boardMode,
    playerSlotsPerTeam: room.playerSlotsPerTeam,
    createdAt: room.createdAt,
    gameState,
    winner: room.winner,
  };
}
