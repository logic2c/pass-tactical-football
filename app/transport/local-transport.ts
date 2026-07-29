import type { SessionCommand, SessionSnapshot, SessionTransport } from "@/shared/types";
import type { GameAction, GameState } from "@/shared/types";
import {
  createGame,
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
  enterCurrentTurn,
  resetFormation,
} from "@/shared/game-engine";
import { runAiStep } from "@/shared/ai-engine";
import { GAME_BALANCE, describeTeam } from "@/shared/constants";

export class LocalSessionTransport implements SessionTransport<GameState> {
  private listeners = new Set<(snapshot: SessionSnapshot<GameState>) => void>();
  private snapshot: SessionSnapshot<GameState>;
  private humanPlayerId: string;

  constructor(humanPlayerId: string) {
    this.humanPlayerId = humanPlayerId;
    this.snapshot = {
      revision: 0,
      state: createGame(),
    };
  }

  async send(command: SessionCommand<GameAction>) {
    const state = structuredClone(this.snapshot.state);
    const action = command.payload;

    // For local transport, handle non-game commands as well
    if (command.type === "game-command") {
      if (this.executeAction(state, action)) autoFinishTurnIfNeeded(state);
    } else if (command.type === "reset-game") {
      const next = createGame();
      next.players.forEach((p) => drawInto(next, p, GAME_BALANCE.startingHand));
      next.players[0].hand.push({ id: "football", kind: "ball" });
      this.snapshot = { revision: this.snapshot.revision + 1, state: next };
      this.listeners.forEach((l) => l(this.snapshot));
      return;
    } else if (command.type === "confirm-kickoff" || command.type === "kickoff") {
      enterCurrentTurn(state);
      const starter = activePlayer(state);
      emitEvent(state, {
        kind: "kickoff",
        actorId: starter.id,
        to: starter.position,
        ballSquare: starter.position,
        label: `${starter.label} 开球`,
        result: `${describeTeam(starter.team)}获得球权，比赛继续。`,
        tone: "success",
      });
      this.snapshot = { revision: this.snapshot.revision + 1, state };
      this.listeners.forEach((l) => l(this.snapshot));
      return;
    } else if (command.type === "reset-formation") {
      resetFormation(state);
      this.snapshot = { revision: this.snapshot.revision + 1, state };
      this.listeners.forEach((l) => l(this.snapshot));
      return;
    }

    // Run AI after human action
    runAiStep(state, [this.humanPlayerId]);

    this.snapshot = { revision: this.snapshot.revision + 1, state };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  private executeAction(game: GameState, action: GameAction): boolean {
    switch (action.kind) {
      case "move": return resolveMoveAction(game, action.cardId, action.position);
      case "pass": return resolvePassAction(game, action.cardId, action.position, this.humanPlayerId);
      case "tackle": return resolveTackleAction(game, action.cardId, action.targetId);
      case "press": return resolvePressAction(game, action.cardId, action.targetId);
      case "flying-kick": return resolveFlyingKickAction(game, action.cardId, action.targetId);
      case "sprint": return resolveSprintAction(game, action.cardId);
      case "supply": return resolveSupplyAction(game, action.cardId);
      case "long-pass": return resolveLongPassAction(game, action.cardId);
      case "save-recycle": return resolveSaveRecycle(game, action.cardId);
      case "save-response": return resolveSaveResponse(game, action.extraCardIds, action.destination);
      case "decline-save": return declineSaveResponse(game);
      case "discard": return discardOverflowAction(game, action.cardId);
      case "skip-draw": {
        const player = activePlayer(game);
        if (game.turn.cardsPlayed !== 0) return false;
        drawInto(game, player, GAME_BALANCE.skipPlayDraw);
        addLog(game, `${player.label} 跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张牌。`);
        emitEvent(game, {
          kind: "skip-draw", actorId: player.id,
          label: `${player.label} 选择战术整备`,
          result: `跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张未知牌。`, tone: "neutral",
        });
        finishPlayPhase(game);
        return true;
      }
      case "end-turn": {
        const player = activePlayer(game);
        emitEvent(game, {
          kind: "end", actorId: player.id,
          label: `${player.label} 结束出牌`, result: "进入弃牌阶段。", tone: "neutral",
        });
        finishPlayPhase(game);
        return true;
      }
      default: return false;
    }
  }

  subscribe(listener: (snapshot: SessionSnapshot<GameState>) => void) {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.listeners.clear();
  }
}
