import type { SessionCommand, SessionSnapshot, SessionTransport } from "@/shared/types";
import type { GameState } from "@/shared/types";

export class WebSocketTransport implements SessionTransport<GameState> {
  private ws: WebSocket | null = null;
  private listeners = new Set<(snapshot: SessionSnapshot<GameState>) => void>();
  private revision = 0;
  private url: string;
  private playerId: string;
  private roomCode: string;
  private onDisconnect: () => void;
  private onReconnect: () => void;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 30;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    url: string,
    playerId: string,
    roomCode: string,
    onDisconnect: () => void,
    onReconnect: () => void,
  ) {
    this.url = url;
    this.playerId = playerId;
    this.roomCode = roomCode;
    this.onDisconnect = onDisconnect;
    this.onReconnect = onReconnect;
    this.connect();
  }

  private connect() {
    const wsUrl = `${this.url}?room=${this.roomCode}&player=${this.playerId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      if (this.reconnectAttempts > 0) {
        this.onReconnect();
        // Send rejoin message
        this.sendRaw({
          type: "join-room",
          payload: { roomCode: this.roomCode, playerId: this.playerId, displayName: "" },
        });
      }
      this.reconnectAttempts = 0;
    };

    this.ws.onmessage = (event) => {
      const envelope = JSON.parse(event.data);
      if (envelope.type === "game-state") {
        this.revision = envelope.revision;
        const snapshot: SessionSnapshot<GameState> = {
          revision: envelope.revision,
          state: envelope.payload,
        };
        this.listeners.forEach((listener) => listener(snapshot));
      } else if (envelope.type === "room-state") {
        // Room state updates: store as a special game phase
        const roomPayload = envelope.payload;
        if (roomPayload.gameState) {
          this.revision = envelope.revision;
          const snapshot: SessionSnapshot<GameState> = {
            revision: envelope.revision,
            state: roomPayload.gameState,
          };
          this.listeners.forEach((listener) => listener(snapshot));
        }
        // Forward room state as a custom event
        this.dispatchRoomState(roomPayload);
      }
    };

    this.ws.onclose = () => {
      if (this.closed) return;
      this.reconnectAttempts++;
      if (this.reconnectAttempts <= this.maxReconnectAttempts) {
        this.onDisconnect();
        const delay = Math.min(2000 * Math.pow(1.5, this.reconnectAttempts - 1), 10000);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    };

    this.ws.onerror = () => {
      // Will trigger onclose
    };
  }

  private roomStateListeners = new Set<(room: unknown) => void>();

  onRoomState(listener: (room: unknown) => void) {
    this.roomStateListeners.add(listener);
    return () => this.roomStateListeners.delete(listener);
  }

  private dispatchRoomState(room: unknown) {
    this.roomStateListeners.forEach((l) => l(room));
  }

  private sendRaw(envelope: { type: string; payload?: unknown }) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(envelope));
    }
  }

  async send(command: SessionCommand): Promise<void> {
    const payload = command.payload;
    if (command.type === "game-command") {
      this.sendRaw({ type: "game-command", payload });
    } else if (command.type === "choose-slot") {
      this.sendRaw({ type: "choose-slot", payload });
    } else if (command.type === "toggle-ready") {
      this.sendRaw({ type: "toggle-ready", payload });
    } else if (command.type === "start-game") {
      this.sendRaw({ type: "start-game", payload });
    } else if (command.type === "leave-room") {
      this.sendRaw({ type: "leave-room", payload });
    }
  }

  subscribe(listener: (snapshot: SessionSnapshot<GameState>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.listeners.clear();
  }
}
