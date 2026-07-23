/**
 * The desktop build currently runs every command in-process. Multiplayer can
 * later implement this boundary with WebSocket messages without changing the
 * screen that issues commands or renders snapshots.
 */
export type SessionCommand<TPayload = unknown> = {
  id: string;
  playerId: string;
  type: string;
  payload: TPayload;
};

export type SessionSnapshot<TState = unknown> = {
  revision: number;
  state: TState;
};

export interface SessionTransport<TState = unknown> {
  send(command: SessionCommand): Promise<void>;
  subscribe(listener: (snapshot: SessionSnapshot<TState>) => void): () => void;
  close(): void;
}

export class LocalSessionTransport<TState> implements SessionTransport<TState> {
  private listeners = new Set<(snapshot: SessionSnapshot<TState>) => void>();

  constructor(
    private snapshot: SessionSnapshot<TState>,
    private readonly reduce: (
      state: TState,
      command: SessionCommand,
    ) => TState,
  ) {}

  async send(command: SessionCommand) {
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      state: this.reduce(this.snapshot.state, command),
    };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  subscribe(listener: (snapshot: SessionSnapshot<TState>) => void) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.listeners.clear();
  }
}
