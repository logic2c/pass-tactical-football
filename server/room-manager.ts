import { createRoom, joinRoom, cleanupRoom, type Room } from "./room";
import type { RoomMode } from "../shared/types";

export class RoomManager {
  private rooms = new Map<string, Room>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Clean up empty/inactive rooms every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  create(mode: RoomMode, displayName: string) {
    let created = createRoom(mode, displayName);
    while (this.rooms.has(created.room.roomCode)) created = createRoom(mode, displayName);
    const { room, playerId, reconnectToken } = created;
    this.rooms.set(room.roomCode, room);
    return { room, playerId, reconnectToken };
  }

  get(roomCode: string): Room | undefined {
    return this.rooms.get(roomCode.toUpperCase());
  }

  getOrCreate(mode: RoomMode, displayName: string) {
    const { room, playerId, reconnectToken } = createRoom(mode, displayName);
    this.rooms.set(room.roomCode, room);
    return { room, playerId, reconnectToken };
  }

  join(roomCode: string, reconnectToken: string | undefined, displayName: string) {
    const room = this.get(roomCode);
    if (!room) return { error: "ROOM_NOT_FOUND" as const };
    if (reconnectToken && !room.reconnectTokens.has(reconnectToken)) {
      return { error: "INVALID_RECONNECT_TOKEN" as const };
    }
    return joinRoom(room, reconnectToken, displayName);
  }

  delete(roomCode: string) {
    const room = this.rooms.get(roomCode);
    if (room) {
      // Close all connections
      room.connections.forEach((ws) => {
        try { ws.close(4001, "room closed"); } catch { /* ignore */ }
      });
      this.rooms.delete(roomCode);
    }
  }

  private cleanup() {
    const toDelete: string[] = [];
    this.rooms.forEach((room, code) => {
      if (cleanupRoom(room)) {
        toDelete.push(code);
      }
    });
    toDelete.forEach((code) => this.delete(code));
  }

  shutdown() {
    clearInterval(this.cleanupTimer);
    this.rooms.forEach((room) => {
      room.connections.forEach((ws) => {
        try { ws.close(4001, "server shutdown"); } catch { /* ignore */ }
      });
    });
    this.rooms.clear();
  }

  get size() {
    return this.rooms.size;
  }
}
