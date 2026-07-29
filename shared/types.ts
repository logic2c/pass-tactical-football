export type Team = "red" | "blue";
export type Suit = "rock" | "bishop" | "knight";
export type BoardMode = "1v1" | "2v2" | "3v3" | "4v4";
export type RoomMode = BoardMode | "3v3-duel" | "4v4-duo";
export type SpecialKind = "tackle" | "sprint" | "supply" | "long-pass" | "save" | "flying-kick";
export type Phase = "setup" | "turn" | "save-response" | "discard" | "kickoff" | "gameover";
export type ActionMode = "move" | "pass" | "tackle" | "press" | "flying-kick" | null;
export type VisualEventKind = "move" | "pass" | "press" | "tackle" | "sprint" | "supply" | "long-pass" | "save" | "flying-kick" | "foul" | "skip-draw" | "end" | "discard" | "goal" | "kickoff";

export type VisualEvent = {
  id: number;
  kind: VisualEventKind;
  actorId?: string;
  targetId?: string;
  from?: number;
  to?: number;
  path?: number[];
  label: string;
  result: string;
  tone?: "neutral" | "success" | "failure" | "goal";
  ballSquare?: number;
  team?: Team;
};

export type ActionCard = { id: string; kind: "action"; suit: Suit; cost: number };
export type SpecialCard = { id: string; kind: "special"; special: SpecialKind; cost: number };
export type BallCard = { id: "football"; kind: "ball" };
export type PlayCard = ActionCard | SpecialCard;
export type GameCard = PlayCard | BallCard;

export type Player = {
  id: string;
  label: string;
  team: Team;
  position: number;
  hand: GameCard[];
  nextTurnPenalty: number;
};

export type ActionTrace = {
  id: number;
  actorId: string;
  team: Team;
  kind: "move" | "pass" | "response";
  from: number;
  to: number;
  path?: number[];
};

export type PendingPass = {
  passerId: string;
  from: number;
  to: number;
  suit: Suit;
  path: number[];
  longPass: boolean;
  responderId?: string;
};

export type TurnState = {
  actionsRemaining: number;
  actionsSpent: number;
  tackleUsed: boolean;
  acquiredBall: boolean;
  cardsPlayed: number;
  longPassReady: boolean;
};

export type GameState = {
  players: Player[];
  deck: PlayCard[];
  discard: PlayCard[];
  looseBall?: number;
  offense: Team;
  scores: Record<Team, number>;
  turnIndex: number;
  turn: TurnState;
  phase: Phase;
  discardQueue: string[];
  discardResume?: "next-turn" | "kickoff";
  log: string[];
  kickoffReason: string;
  winner?: Team;
  aiNote?: string;
  eventSeq: number;
  lastEvent?: VisualEvent;
  traceSeq: number;
  traces: ActionTrace[];
  pendingPass?: PendingPass;
};

// AI types
export type AiCandidate<T> = {
  value: T;
  score: number;
  reason: string;
};

export type AiSelection<T> = AiCandidate<T> & {
  probability: number;
};

export type AiTurnPlan =
  | { kind: "skip-draw" }
  | { kind: "end" }
  | { kind: "move"; cardId: string; position: number }
  | { kind: "tackle"; cardId: string; targetId: string }
  | { kind: "press"; cardId: string; targetId: string }
  | { kind: "pass"; cardId: string; position: number }
  | { kind: "sprint"; cardId: string }
  | { kind: "supply"; cardId: string }
  | { kind: "long-pass"; cardId: string }
  | { kind: "save-recycle"; cardId: string }
  | { kind: "flying-kick"; cardId: string; targetId: string };

// GameAction: sent from client to server as a game command
export type GameAction =
  | { kind: "move"; cardId: string; position: number }
  | { kind: "pass"; cardId: string; position: number }
  | { kind: "tackle"; cardId: string; targetId: string }
  | { kind: "press"; cardId: string; targetId: string }
  | { kind: "flying-kick"; cardId: string; targetId: string }
  | { kind: "sprint"; cardId: string }
  | { kind: "supply"; cardId: string }
  | { kind: "long-pass"; cardId: string }
  | { kind: "save-recycle"; cardId: string }
  | { kind: "skip-draw" }
  | { kind: "end-turn" }
  | { kind: "save-response"; extraCardIds: string[]; destination: number }
  | { kind: "decline-save" }
  | { kind: "discard"; cardId: string }
  | { kind: "setup-position"; actorId: string; position: number }
  | { kind: "confirm-kickoff" };

// Session transport types
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

// Room types for multiplayer
export type RoomStatus = "lobby" | "playing" | "finished";

export type PlayerSlot = {
  playerId: string;
  displayName: string;
  positionId: string | null;
  positionIds: string[];
  team: Team | null;
  isHost: boolean;
  isReady: boolean;
  isConnected: boolean;
  isSpectator: boolean;
};

export type RoomState = {
  roomCode: string;
  status: RoomStatus;
  slots: PlayerSlot[];
  gameMode: RoomMode;
  boardMode: BoardMode;
  playerSlotsPerTeam: 1 | 2 | 3 | 4;
  createdAt: number;
  gameState?: GameState;
  winner?: Team;
};
