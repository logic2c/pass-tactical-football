import type { GameState } from "../shared/types";
import type { GameAction } from "../shared/types";
import {
  createGame,
  enterCurrentTurn,
  resolveMoveAction,
  resolvePassAction,
  resolveTackleAction,
  resolvePressAction,
  resolveFlyingKickAction,
  resolveSprintAction,
  resolveSupplyAction,
  resolveLongPassAction,
  resolveSaveRecycle,
  resolveSaveResponse,
  declineSaveResponse,
  discardOverflowAction,
  finishPlayPhase,
  drawInto,
  addLog,
  emitEvent,
  activePlayer,
  autoFinishTurnIfNeeded,
  playerById,
  isLegalSetupPosition,
} from "../shared/game-engine";
import { runAiStep, phaseActorId } from "../shared/ai-engine";
import { GAME_BALANCE, describeTeam } from "../shared/constants";
import type { Room } from "./room";
import { controlledPositionIds, findSlot, slotControls } from "./room";

type BroadcastFn = (room: Room) => void;

const TURN_TIMEOUT = 60_000;
const SAVE_TIMEOUT = 30_000;
const DISCARD_TIMEOUT = 30_000;
const AI_DELAY = 980;

export class GameRunner {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  startGame(room: Room) {
    const game = createGame(room.boardMode);
    room.gameState = game;
    room.revision = 0;

    // Bind room seats to game actors and keep the chosen display names in all events/logs.
    room.slots.filter((slot) => !slot.isSpectator).forEach((slot) => {
      const ownedIds = controlledPositionIds(slot);
      ownedIds.forEach((actorId) => {
        const gamePlayer = game.players.find((player) => player.id === actorId);
        if (gamePlayer) gamePlayer.label = ownedIds.length > 1 ? `${slot.displayName} · ${actorId.toUpperCase()}` : slot.displayName;
      });
    });

    this.broadcast(room);
    this.scheduleAiIfNeeded(room);
  }

  processCommand(room: Room, playerId: string, action: GameAction): { ok: boolean; error?: string } {
    const game = room.gameState;
    if (!game) return { ok: false, error: "GAME_NOT_STARTED" };

    const slot = findSlot(room, playerId);
    if (!slot || slot.isSpectator) return { ok: false, error: "NOT_A_PLAYER" };

    // Validate it's this player's turn/phase
    // During setup/kickoff, special handling: position changes allowed, confirm-kickoff only by host
    if (action.kind === "setup-position") {
      if (game.phase !== "setup" && game.phase !== "kickoff") {
        return { ok: false, error: "NOT_SETUP_PHASE" };
      }
      // Validate the player owns this game position (slot.positionId matches game player ID)
      const gamePlayer = game.players.find((p) => p.id === action.actorId && slotControls(slot, action.actorId));
      if (!gamePlayer) {
        return { ok: false, error: "NOT_YOUR_PLAYER" };
      }
    } else if (action.kind === "confirm-kickoff") {
      if (game.phase !== "setup" && game.phase !== "kickoff") {
        return { ok: false, error: "NOT_SETUP_OR_KICKOFF" };
      }
      // Initial setup is started by the host; later kickoffs are confirmed by the receiver.
      if ((game.phase === "setup" && !slot.isHost) || (game.phase === "kickoff" && !slotControls(slot, activePlayer(game).id))) {
        return { ok: false, error: game.phase === "setup" ? "NOT_HOST" : "NOT_KICKOFF_RECEIVER" };
      }
    } else {
      const actorId = phaseActorId(game);
      if (!actorId || !slotControls(slot, actorId)) {
        return { ok: false, error: "NOT_YOUR_TURN" };
      }
    }

    // Validate the specific action
    const ownedIds = controlledPositionIds(slot);
    if (ownedIds.length === 0) return { ok: false, error: "PLAYER_NOT_FOUND" };

    const result = this.executeAction(game, action, ownedIds);
    if (!result) return { ok: false, error: "INVALID_ACTION" };
    autoFinishTurnIfNeeded(game);

    room.revision++;
    this.clearTimer(room.roomCode);
    this.scheduleAiIfNeeded(room);
    return { ok: true };
  }

  private executeAction(game: GameState, action: GameAction, controlledIds: string[]): boolean {
    switch (action.kind) {
      case "move":
        return resolveMoveAction(game, action.cardId, action.position);
      case "pass":
        return resolvePassAction(game, action.cardId, action.position, controlledIds);
      case "tackle":
        return resolveTackleAction(game, action.cardId, action.targetId);
      case "press":
        return resolvePressAction(game, action.cardId, action.targetId);
      case "flying-kick":
        return resolveFlyingKickAction(game, action.cardId, action.targetId);
      case "sprint":
        return resolveSprintAction(game, action.cardId);
      case "supply":
        return resolveSupplyAction(game, action.cardId);
      case "long-pass":
        return resolveLongPassAction(game, action.cardId);
      case "save-recycle":
        return resolveSaveRecycle(game, action.cardId);
      case "skip-draw": {
        const player = activePlayer(game);
        if (game.turn.cardsPlayed !== 0) return false;
        drawInto(game, player, GAME_BALANCE.skipPlayDraw);
        addLog(game, `${player.label} 跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张牌。`);
        emitEvent(game, {
          kind: "skip-draw",
          actorId: player.id,
          label: `${player.label} 选择战术整备`,
          result: `跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张未知牌。`,
          tone: "neutral",
        });
        finishPlayPhase(game);
        return true;
      }
      case "end-turn": {
        const player = activePlayer(game);
        emitEvent(game, {
          kind: "end",
          actorId: player.id,
          label: `${player.label} 结束出牌`,
          result: "进入弃牌阶段。",
          tone: "neutral",
        });
        finishPlayPhase(game);
        return true;
      }
      case "save-response":
        return resolveSaveResponse(game, action.extraCardIds, action.destination);
      case "decline-save":
        return declineSaveResponse(game);
      case "discard":
        return discardOverflowAction(game, action.cardId);
      case "setup-position": {
        if (game.phase !== "setup" && game.phase !== "kickoff") return false;
        if (!controlledIds.includes(action.actorId)) return false;
        const selected = playerById(game, action.actorId);
        if (!selected) return false;
        if (!isLegalSetupPosition(game, selected, action.position)) return false;
        selected.position = action.position;
        return true;
      }
      case "confirm-kickoff": {
        if (game.phase !== "setup" && game.phase !== "kickoff") return false;
        enterCurrentTurn(game);
        const starter = activePlayer(game);
        emitEvent(game, {
          kind: "kickoff",
          actorId: starter.id,
          to: starter.position,
          ballSquare: starter.position,
          label: `${starter.label} 开球`,
          result: `${describeTeam(starter.team)}获得球权，比赛继续。`,
          tone: "success",
        });
        return true;
      }
      default:
        return false;
    }
  }

  private scheduleAiIfNeeded(room: Room) {
    const game = room.gameState;
    if (!game) return;

    // Check if game is over
    if (game.phase === "gameover") {
      room.status = "finished";
      room.winner = game.winner;
      room.finishedAt ??= Date.now();
      this.broadcast(room);
      return;
    }

    const actorId = phaseActorId(game);
    if (!actorId) return;

    // Check if current actor is human (connected and not spectator)
    const slot = room.slots.find((s) => !s.isSpectator && slotControls(s, actorId));
    if (slot?.isConnected) {
      // Human player's turn — set timeout for AFK
      const timeout = game.phase === "save-response" ? SAVE_TIMEOUT
        : game.phase === "discard" ? DISCARD_TIMEOUT
        : TURN_TIMEOUT;

      this.timers.set(room.roomCode, setTimeout(() => {
        this.handleTimeout(room);
      }, timeout));

      this.broadcast(room);
      return;
    }

    // AI turn — run after a brief delay for visual pacing
    this.timers.set(room.roomCode, setTimeout(() => {
      this.runAiAndContinue(room);
    }, AI_DELAY));
  }

  private handleTimeout(room: Room) {
    const game = room.gameState;
    if (!game) return;

    const actorId = phaseActorId(game);
    if (!actorId) return;

    const slot = room.slots.find((s) => slotControls(s, actorId));
    if (!slot?.isConnected) return; // Already disconnected

    // Auto-action on timeout
    if (game.phase === "turn") {
      const player = activePlayer(game);
      addLog(game, `${player.label} 超时未行动，自动结束出牌。`);
      emitEvent(game, {
        kind: "end",
        actorId: player.id,
        label: `${player.label} 超时`,
        result: "超时未行动，自动结束出牌。",
        tone: "neutral",
      });
      finishPlayPhase(game);
    } else if (game.phase === "save-response") {
      declineSaveResponse(game);
    } else if (game.phase === "discard") {
      // AI will auto-discard; just trigger the next step
      const humanIds = room.slots.filter((s) => s.isConnected && !s.isSpectator).flatMap(controlledPositionIds);
      runAiStep(game, humanIds);
    }

    room.revision++;
    this.scheduleAiIfNeeded(room);
  }

  private runAiAndContinue(room: Room) {
    const game = room.gameState;
    if (!game) return;

    const humanIds = room.slots
      .filter((s) => s.isConnected && !s.isSpectator)
      .flatMap(controlledPositionIds);

    runAiStep(game, humanIds);
    room.revision++;

    this.scheduleAiIfNeeded(room);
  }

  private clearTimer(roomCode: string) {
    const timer = this.timers.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(roomCode);
    }
  }

  cleanup(roomCode: string) {
    this.clearTimer(roomCode);
    this.timers.delete(roomCode);
  }
}
