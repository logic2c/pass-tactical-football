"use client";

import { useMemo, useState } from "react";
import {
  BLUE_GOAL,
  RED_GOAL,
  enemyGoal,
  isGoal,
  movementTargets,
  passPath,
  sprintTargets,
} from "./game-rules";

type Team = "red" | "blue";
type Suit = "rock" | "bishop" | "knight";
type Phase =
  | "setup"
  | "turn"
  | "pass-response"
  | "pass-target"
  | "intercept"
  | "discard"
  | "kickoff"
  | "gameover";
type ActionMode = "move" | "pass" | "tackle" | null;
type ResponseStep = "card" | "discard";

type ActionCard = { id: string; kind: "action"; suit: Suit };
type BallCard = { id: "football"; kind: "ball" };
type GameCard = ActionCard | BallCard;

type Player = {
  id: string;
  label: string;
  team: Team;
  position: number;
  hand: GameCard[];
};

type PassState = {
  passerId: string;
  actionCard: ActionCard;
  payload: GameCard[];
  responders: string[];
  responseIndex: number;
  responseStep: ResponseStep;
  blockerId?: string;
  targetId?: string;
};

type GameState = {
  players: Player[];
  deck: ActionCard[];
  discard: ActionCard[];
  offense: Team;
  scores: Record<Team, number>;
  turnIndex: number;
  phase: Phase;
  pass?: PassState;
  discardQueue: string[];
  discardResume?: "next-turn" | "kickoff";
  log: string[];
  kickoffReason: string;
  winner?: Team;
};

const TURN_ORDER = ["r1", "b1", "b2", "r2", "r3", "b3"];
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

const SUIT_INFO: Record<Suit, { name: string; icon: string; caption: string }> = {
  rock: { name: "ROCK", icon: "+", caption: "横纵" },
  bishop: { name: "BISHOP", icon: "×", caption: "斜线" },
  knight: { name: "KNIGHT", icon: "L", caption: "走日" },
};

const FORMATION: Record<string, number> = {
  r1: 51,
  r2: 53,
  r3: 44,
  b1: 11,
  b2: 13,
  b3: 20,
};

function shuffle<T>(items: T[]) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function buildDeck(): ActionCard[] {
  return shuffle(
    (["rock", "bishop", "knight"] as Suit[]).flatMap((suit) =>
      Array.from({ length: 20 }, (_, index) => ({
        id: `${suit}-${index + 1}`,
        kind: "action" as const,
        suit,
      })),
    ),
  );
}

function drawInto(game: GameState, player: Player, count: number) {
  for (let draw = 0; draw < count; draw += 1) {
    if (game.deck.length === 0 && game.discard.length > 0) {
      game.deck = shuffle(game.discard);
      game.discard = [];
      game.log.unshift("弃牌堆已重新洗成牌库。");
    }
    const card = game.deck.pop();
    if (!card) break;
    player.hand.push(card);
  }
}

function createGame(): GameState {
  const game: GameState = {
    players: TURN_ORDER.map((id) => ({
      id,
      label: id.toUpperCase(),
      team: id.startsWith("r") ? "red" : "blue",
      position: FORMATION[id],
      hand: [],
    })),
    deck: buildDeck(),
    discard: [],
    offense: "red",
    scores: { red: 0, blue: 0 },
    turnIndex: 0,
    phase: "setup",
    discardQueue: [],
    log: ["布置六名球员的位置，然后由 R1 开球。"],
    kickoffReason: "赛前布阵",
  };

  game.players.forEach((player) => drawInto(game, player, 3));
  game.players[0].hand.push({ id: "football", kind: "ball" });
  return game;
}

function playerById(game: GameState, id: string) {
  return game.players.find((player) => player.id === id)!;
}

function activePlayer(game: GameState) {
  return playerById(game, TURN_ORDER[game.turnIndex]);
}

function hasBall(player: Player) {
  return player.hand.some((card) => card.kind === "ball");
}

function handLimit(game: GameState, player: Player) {
  return player.team === game.offense ? 5 : 6;
}

function describeTeam(team: Team) {
  return team === "red" ? "红队" : "蓝队";
}

function squareName(position: number) {
  return `${FILES[position % 8]}${8 - Math.floor(position / 8)}`;
}

function addLog(game: GameState, message: string) {
  game.log.unshift(message);
  game.log = game.log.slice(0, 28);
}

function nextTurn(game: GameState) {
  game.turnIndex = (game.turnIndex + 1) % TURN_ORDER.length;
  game.phase = "turn";
  game.pass = undefined;
  game.discardQueue = [];
  game.discardResume = undefined;
  addLog(game, `轮到 ${activePlayer(game).label}。`);
}

function finishAction(game: GameState) {
  const endingPlayer = activePlayer(game);
  if (endingPlayer.hand.length > handLimit(game, endingPlayer)) {
    game.phase = "discard";
    game.discardQueue = [endingPlayer.id];
    game.discardResume = "next-turn";
    game.pass = undefined;
    addLog(game, `${endingPlayer.label} 的回合结束，需要将手牌弃至上限。`);
    return;
  }
  nextTurn(game);
}

function nextOpponent(game: GameState, fromId: string, team: Team) {
  const start = TURN_ORDER.indexOf(fromId);
  for (let step = 1; step <= TURN_ORDER.length; step += 1) {
    const id = TURN_ORDER[(start + step) % TURN_ORDER.length];
    if (playerById(game, id).team === team) return id;
  }
  return team === "red" ? "r1" : "b1";
}

function resetFormation(game: GameState) {
  game.players.forEach((player) => {
    player.position = FORMATION[player.id];
  });
}

function moveBallTo(game: GameState, recipientId: string) {
  let ball: BallCard | undefined;
  game.players.forEach((player) => {
    const ballIndex = player.hand.findIndex((card) => card.kind === "ball");
    if (ballIndex >= 0) {
      ball = player.hand.splice(ballIndex, 1)[0] as BallCard;
    }
  });
  if (!ball && game.pass) {
    const ballIndex = game.pass.payload.findIndex((card) => card.kind === "ball");
    if (ballIndex >= 0) {
      ball = game.pass.payload.splice(ballIndex, 1)[0] as BallCard;
    }
  }
  playerById(game, recipientId).hand.push(ball ?? { id: "football", kind: "ball" });
}

function kickoff(game: GameState, receiverId: string, reason: string, endingPlayerId?: string) {
  moveBallTo(game, receiverId);
  game.offense = playerById(game, receiverId).team;
  game.turnIndex = TURN_ORDER.indexOf(receiverId);
  game.pass = undefined;
  game.discardQueue = [];
  game.discardResume = undefined;
  game.kickoffReason = reason;
  resetFormation(game);
  addLog(game, `${reason} ${playerById(game, receiverId).label} 获得球权，双方重新布阵。`);

  const endingPlayer = endingPlayerId ? playerById(game, endingPlayerId) : undefined;
  if (endingPlayer && endingPlayer.hand.length > handLimit(game, endingPlayer)) {
    game.phase = "discard";
    game.discardQueue = [endingPlayer.id];
    game.discardResume = "kickoff";
    addLog(game, `${endingPlayer.label} 需先处理自己回合结束时的超限手牌。`);
  } else {
    game.phase = "kickoff";
  }
}

function returnPassPayload(game: GameState) {
  if (!game.pass) return;
  const passer = playerById(game, game.pass.passerId);
  passer.hand.push(...game.pass.payload);
  game.pass.payload = [];
}

function isOwnHalf(player: Player, position: number) {
  const row = Math.floor(position / 8);
  return player.team === "red" ? row >= 4 : row <= 3;
}

function passTargets(game: GameState) {
  const state = game.pass;
  if (!state) return new Set<number>();
  const passer = playerById(game, state.passerId);
  const targets = new Set<number>();
  game.players
    .filter((player) => player.team === passer.team && player.id !== passer.id)
    .forEach((player) => {
      if (passPath(passer.position, player.position, state.actionCard.suit)) {
        targets.add(player.position);
      }
    });
  if (
    state.payload.some((card) => card.kind === "ball") &&
    passPath(passer.position, enemyGoal(passer.team), state.actionCard.suit)
  ) {
    targets.add(enemyGoal(passer.team));
  }
  return targets;
}

function cardSummary(cards: GameCard[]) {
  const ball = cards.some((card) => card.kind === "ball");
  const actionCount = cards.filter((card) => card.kind === "action").length;
  return `${ball ? "足球 + " : ""}${actionCount} 张行动牌`;
}

export default function Home() {
  const [game, setGame] = useState<GameState>(() => createGame());
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<ActionMode>(null);
  const [payloadIds, setPayloadIds] = useState<string[]>([]);
  const [responseIds, setResponseIds] = useState<string[]>([]);
  const [setupPlayerId, setSetupPlayerId] = useState<string>("r1");

  const current = activePlayer(game);
  const responderId =
    game.phase === "pass-response" && game.pass
      ? game.pass.responders[game.pass.responseIndex]
      : undefined;
  const focusPlayer =
    game.phase === "pass-response" && responderId
      ? playerById(game, responderId)
      : game.phase === "discard" && game.discardQueue[0]
        ? playerById(game, game.discardQueue[0])
        : current;

  const selectedCard = current.hand.find(
    (card): card is ActionCard => card.id === selectedCardId && card.kind === "action",
  );

  const validCells = useMemo(() => {
    if (game.phase === "turn" && actionMode === "move" && selectedCard) {
      return movementTargets(game, current, selectedCard.suit);
    }
    if (game.phase === "pass-target") return passTargets(game);
    if (game.phase === "pass-response" && responderId && game.pass) {
      const responder = playerById(game, responderId);
      if (game.pass.responseStep === "card" && responseIds.length === 1) {
        const card = responder.hand.find(
          (item): item is ActionCard => item.id === responseIds[0] && item.kind === "action",
        );
        return card ? movementTargets(game, responder, card.suit) : new Set<number>();
      }
      if (game.pass.responseStep === "discard" && responseIds.length > 0) {
        return sprintTargets(game, responder, responseIds.length);
      }
    }
    return new Set<number>();
  }, [game, actionMode, selectedCard, responderId, responseIds, current]);

  function clearSelections() {
    setSelectedCardId(null);
    setActionMode(null);
    setPayloadIds([]);
    setResponseIds([]);
  }

  function startKickoff() {
    setGame((previous) => {
      const next = structuredClone(previous);
      const kickoffPlayer = activePlayer(next);
      next.phase = "turn";
      addLog(next, `${kickoffPlayer.label} 开球，比赛继续。`);
      return next;
    });
    clearSelections();
  }

  function resetPositions() {
    setGame((previous) => {
      const next = structuredClone(previous);
      resetFormation(next);
      return next;
    });
    setSetupPlayerId("r1");
  }

  function drawCardsForTurn() {
    setGame((previous) => {
      const next = structuredClone(previous);
      const player = activePlayer(next);
      const count = player.team === next.offense ? 2 : 3;
      drawInto(next, player, count);
      addLog(next, `${player.label} 选择抽牌，获得 ${count} 张行动牌。`);
      finishAction(next);
      return next;
    });
    clearSelections();
  }

  function performMove(position: number) {
    if (!selectedCard || !validCells.has(position)) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const player = activePlayer(next);
      const cardIndex = player.hand.findIndex((card) => card.id === selectedCard.id);
      const [usedCard] = player.hand.splice(cardIndex, 1) as ActionCard[];
      next.discard.push(usedCard);

      if (position === enemyGoal(player.team) && hasBall(player)) {
        const receiverId = nextOpponent(next, player.id, player.team === "red" ? "blue" : "red");
        addLog(next, `${player.label} 试图带球进入球门，触发越位并交换球权。`);
        kickoff(next, receiverId, "越位重开：", player.id);
        return next;
      }

      player.position = position;
      addLog(next, `${player.label} 使用 ${SUIT_INFO[usedCard.suit].name} 移动到 ${squareName(position)}。`);
      finishAction(next);
      return next;
    });
    clearSelections();
  }

  function performTackle(targetId: string) {
    if (!selectedCard || actionMode !== "tackle") return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const player = activePlayer(next);
      const target = playerById(next, targetId);
      if (player.team === next.offense || target.team === player.team || target.hand.length === 0) return previous;

      const actionIndex = player.hand.findIndex((card) => card.id === selectedCard.id);
      const [usedCard] = player.hand.splice(actionIndex, 1) as ActionCard[];
      next.discard.push(usedCard);

      const takenIndex = Math.floor(Math.random() * target.hand.length);
      const [taken] = target.hand.splice(takenIndex, 1);
      player.hand.push(taken);
      if (taken.kind === "ball") {
        next.offense = player.team;
        addLog(next, `${player.label} 抢断 ${target.label} 并抽中足球！${describeTeam(player.team)}转为进攻。`);
      } else {
        addLog(next, `${player.label} 抢断 ${target.label}，抽到一张 ${SUIT_INFO[taken.suit].name}。`);
      }
      finishAction(next);
      return next;
    });
    clearSelections();
  }

  function confirmPass() {
    if (!selectedCard || payloadIds.length === 0) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const passer = activePlayer(next);
      if (passer.team !== next.offense) return previous;
      const actionIndex = passer.hand.findIndex((card) => card.id === selectedCard.id);
      const [passCard] = passer.hand.splice(actionIndex, 1) as ActionCard[];
      next.discard.push(passCard);
      const payload: GameCard[] = [];
      payloadIds.forEach((id) => {
        const index = passer.hand.findIndex((card) => card.id === id);
        if (index >= 0) payload.push(...passer.hand.splice(index, 1));
      });
      const startIndex = TURN_ORDER.indexOf(passer.id);
      const responders = Array.from({ length: TURN_ORDER.length - 1 }, (_, index) =>
        TURN_ORDER[(startIndex + index + 1) % TURN_ORDER.length],
      );
      next.pass = {
        passerId: passer.id,
        actionCard: passCard,
        payload,
        responders,
        responseIndex: 0,
        responseStep: "card",
      };
      next.phase = "pass-response";
      addLog(next, `${passer.label} 发起 ${SUIT_INFO[passCard.suit].name} Pass，倒扣 ${payload.length} 张牌。`);
      return next;
    });
    clearSelections();
  }

  function advanceResponse(next: GameState) {
    if (!next.pass) return;
    next.pass.responseIndex += 1;
    next.pass.responseStep = "card";
    if (next.pass.responseIndex >= next.pass.responders.length) {
      const passer = playerById(next, next.pass.passerId);
      if (passTargets(next).size === 0) {
        const defendingTeam: Team = passer.team === "red" ? "blue" : "red";
        const chooserId = nextOpponent(next, passer.id, defendingTeam);
        next.pass.blockerId = chooserId;
        next.phase = "intercept";
        addLog(next, `场上没有合法传球目标，倒扣牌揭开，由 ${playerById(next, chooserId).label} 选择一张。`);
      } else {
        next.phase = "pass-target";
        addLog(next, `${passer.label} 现在必须选择传球目标。`);
      }
    }
  }

  function skipResponseStep() {
    setGame((previous) => {
      const next = structuredClone(previous);
      if (!next.pass) return previous;
      const responder = playerById(next, next.pass.responders[next.pass.responseIndex]);
      if (next.pass.responseStep === "card") {
        next.pass.responseStep = "discard";
        addLog(next, `${responder.label} 跳过按牌移动，进入弃牌冲刺步骤。`);
      } else {
        addLog(next, `${responder.label} 完成响应移动。`);
        advanceResponse(next);
      }
      return next;
    });
    setResponseIds([]);
  }

  function performResponseMove(position: number) {
    if (!responderId || !game.pass || !validCells.has(position)) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      if (!next.pass) return previous;
      const passerId = next.pass.passerId;
      const responder = playerById(next, next.pass.responders[next.pass.responseIndex]);
      const selected = [...responseIds];
      if (next.pass.responseStep === "card" && selected.length === 1) {
        const index = responder.hand.findIndex((card) => card.id === selected[0] && card.kind === "action");
        if (index < 0) return previous;
        const [used] = responder.hand.splice(index, 1) as ActionCard[];
        next.discard.push(used);
        if (position === enemyGoal(responder.team) && hasBall(responder)) {
          returnPassPayload(next);
          const receivingTeam: Team = responder.team === "red" ? "blue" : "red";
          const receiverId = nextOpponent(next, responder.id, receivingTeam);
          addLog(next, `${responder.label} 在响应移动中试图带球进入球门，触发越位并终止本次 Pass。`);
          kickoff(next, receiverId, "越位重开：", passerId);
          return next;
        }
        responder.position = position;
        addLog(next, `${responder.label} 在传球响应中使用 ${SUIT_INFO[used.suit].name} 移动。`);
        next.pass.responseStep = "discard";
      } else if (next.pass.responseStep === "discard" && selected.length > 0) {
        const discarded: ActionCard[] = [];
        selected.forEach((id) => {
          const index = responder.hand.findIndex((card) => card.id === id && card.kind === "action");
          if (index >= 0) discarded.push(...(responder.hand.splice(index, 1) as ActionCard[]));
        });
        if (discarded.length !== selected.length) return previous;
        next.discard.push(...discarded);
        if (position === enemyGoal(responder.team) && hasBall(responder)) {
          returnPassPayload(next);
          const receivingTeam: Team = responder.team === "red" ? "blue" : "red";
          const receiverId = nextOpponent(next, responder.id, receivingTeam);
          addLog(next, `${responder.label} 在弃牌冲刺中试图带球进入球门，触发越位并终止本次 Pass。`);
          kickoff(next, receiverId, "越位重开：", passerId);
          return next;
        }
        responder.position = position;
        addLog(next, `${responder.label} 弃掉 ${discarded.length} 张牌，冲刺到 ${squareName(position)}。`);
        advanceResponse(next);
      } else {
        return previous;
      }
      return next;
    });
    setResponseIds([]);
  }

  function resolvePass(position: number) {
    if (!game.pass || !validCells.has(position)) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const state = next.pass;
      if (!state) return previous;
      const passer = playerById(next, state.passerId);
      const path = passPath(passer.position, position, state.actionCard.suit);
      if (!path) return previous;
      const blockers = path
        .map((cell) => next.players.find((player) => player.position === cell && player.team !== passer.team))
        .filter((player): player is Player => Boolean(player));

      if (blockers.length > 0) {
        state.blockerId = blockers[0].id;
        state.targetId = isGoal(position)
          ? `goal-${passer.team === "red" ? "blue" : "red"}`
          : next.players.find((player) => player.position === position)?.id;
        next.phase = "intercept";
        addLog(next, `${blockers[0].label} 截断了传球路线，倒扣牌全部揭开。`);
        return next;
      }

      if (position === enemyGoal(passer.team)) {
        const scoringTeam = passer.team;
        next.scores[scoringTeam] += 1;
        const actionCards = state.payload.filter((card): card is ActionCard => card.kind === "action");
        next.discard.push(...actionCards);
        addLog(next, `${passer.label} 将足球传入 ${squareName(position)}！${describeTeam(scoringTeam)}得分。`);
        if (next.scores[scoringTeam] >= 3) {
          next.phase = "gameover";
          next.winner = scoringTeam;
          next.pass = undefined;
          return next;
        }
        const receivingTeam: Team = scoringTeam === "red" ? "blue" : "red";
        const receiverId = nextOpponent(next, passer.id, receivingTeam);
        kickoff(next, receiverId, "进球后开球：", passer.id);
        return next;
      }

      const recipient = next.players.find((player) => player.position === position);
      if (!recipient || recipient.team !== passer.team) return previous;
      recipient.hand.push(...state.payload);
      addLog(next, `${passer.label} 成功把 ${cardSummary(state.payload)} 交给 ${recipient.label}。`);
      next.pass = undefined;
      finishAction(next);
      return next;
    });
    clearSelections();
  }

  function chooseInterceptCard(cardId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      const state = next.pass;
      if (!state?.blockerId) return previous;
      const cardIndex = state.payload.findIndex((card) => card.id === cardId);
      if (cardIndex < 0) return previous;
      const [chosen] = state.payload.splice(cardIndex, 1);
      const blocker = playerById(next, state.blockerId);
      const passer = playerById(next, state.passerId);
      blocker.hand.push(chosen);
      passer.hand.push(...state.payload);
      if (chosen.kind === "ball") {
        next.offense = blocker.team;
        addLog(next, `${blocker.label} 从传球组合中选走足球，${describeTeam(blocker.team)}转为进攻。`);
      } else {
        addLog(next, `${blocker.label} 选走一张 ${SUIT_INFO[chosen.suit].name}；足球若在组合中则回到 ${passer.label}。`);
      }
      next.pass = undefined;
      finishAction(next);
      return next;
    });
    clearSelections();
  }

  function discardOverflow(cardId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      const playerId = next.discardQueue[0];
      if (!playerId) return previous;
      const player = playerById(next, playerId);
      const index = player.hand.findIndex((card) => card.id === cardId && card.kind === "action");
      if (index < 0) return previous;
      const [card] = player.hand.splice(index, 1) as ActionCard[];
      next.discard.push(card);
      addLog(next, `${player.label} 弃掉一张 ${SUIT_INFO[card.suit].name}。`);
      if (player.hand.length <= handLimit(next, player)) {
        next.discardQueue.shift();
      }
      if (next.discardQueue.length === 0) {
        if (next.discardResume === "kickoff") {
          next.phase = "kickoff";
          next.discardResume = undefined;
          addLog(next, "手牌已处理完毕，可以重新布阵并开球。");
        } else {
          nextTurn(next);
        }
      }
      return next;
    });
  }

  function handleCell(position: number) {
    const occupant = game.players.find((player) => player.position === position);
    if (game.phase === "setup" || game.phase === "kickoff") {
      if (occupant) {
        setSetupPlayerId(occupant.id);
        return;
      }
      const player = playerById(game, setupPlayerId);
      if (!player || !isOwnHalf(player, position) || isGoal(position)) return;
      setGame((previous) => {
        const next = structuredClone(previous);
        playerById(next, setupPlayerId).position = position;
        return next;
      });
      return;
    }
    if (game.phase === "turn" && actionMode === "move") {
      performMove(position);
      return;
    }
    if (game.phase === "turn" && actionMode === "tackle" && occupant) {
      performTackle(occupant.id);
      return;
    }
    if (game.phase === "pass-response" && responseIds.length > 0) {
      performResponseMove(position);
      return;
    }
    if (game.phase === "pass-target") resolvePass(position);
  }

  function togglePayload(id: string) {
    setPayloadIds((currentIds) =>
      currentIds.includes(id) ? currentIds.filter((item) => item !== id) : [...currentIds, id],
    );
  }

  function toggleResponseCard(id: string) {
    if (game.pass?.responseStep === "card") {
      setResponseIds((currentIds) => (currentIds.includes(id) ? [] : [id]));
    } else {
      setResponseIds((currentIds) =>
        currentIds.includes(id) ? currentIds.filter((item) => item !== id) : [...currentIds, id],
      );
    }
  }

  const phaseCopy = (() => {
    if (game.phase === "setup") return ["赛前布阵", "点击球员，再点击己方半场空格。双方都布置好后开始。"];
    if (game.phase === "kickoff") return [game.kickoffReason, "双方已回到默认阵型；你仍可调整各自在己方半场的位置。"];
    if (game.phase === "turn") return [`${current.label} 的回合`, "选择抽牌，或选择一张行动牌执行一个合法行动。"];
    if (game.phase === "pass-response" && responderId && game.pass)
      return game.pass.responseStep === "card"
        ? [`${playerById(game, responderId).label} · 响应第 1 步`, "选择一张牌按属性移动，或跳过并进入弃牌冲刺。"]
        : [`${playerById(game, responderId).label} · 响应第 2 步`, "可弃任意数量行动牌横纵冲刺相同步数，也可以直接完成响应。"];
    if (game.phase === "pass-target") return ["决定传球目标", "点击高亮的队友；若组合含足球，也可以点击高亮球门。"];
    if (game.phase === "intercept" && game.pass?.blockerId)
      return [`${playerById(game, game.pass.blockerId).label} 选择截获牌`, "整组牌已经揭开。选一张加入手牌，其余返回传球者。"];
    if (game.phase === "discard" && game.discardQueue[0]) {
      const player = playerById(game, game.discardQueue[0]);
      return [`${player.label} 手牌超限`, `点击行动牌弃置，直到不超过 ${handLimit(game, player)} 张；足球不能弃置。`];
    }
    if (game.phase === "gameover" && game.winner) return [`${describeTeam(game.winner)}获胜`, "三球已到，比赛结束。可以重开继续测试。"];
    return ["PASS", "六人本地规则测试版"];
  })();

  return (
    <main className="game-shell">
      <header className="match-header">
        <div className="brand-block">
          <div className="brand-mark">P</div>
          <div>
            <p className="kicker">TACTICAL FOOTBALL CARD GAME</p>
            <h1>PASS</h1>
          </div>
        </div>

        <section className="scoreboard" aria-label="比分">
          <div className="team-score red-score"><span>RED</span><strong>{game.scores.red}</strong></div>
          <div className="score-divider"><span>FIRST TO 3</span><b>:</b></div>
          <div className="team-score blue-score"><strong>{game.scores.blue}</strong><span>BLUE</span></div>
        </section>

        <div className="header-actions">
          <span className={`possession ${game.offense}`}>{describeTeam(game.offense)}进攻</span>
          <button className="quiet-button" onClick={() => { setGame(createGame()); clearSelections(); setSetupPlayerId("r1"); }}>
            重开比赛
          </button>
        </div>
      </header>

      <nav className="turn-ribbon" aria-label="回合顺序">
        <span className="turn-label">TURN ORDER</span>
        {TURN_ORDER.map((id, index) => {
          const player = playerById(game, id);
          return (
            <div key={id} className={`turn-chip ${player.team} ${index === game.turnIndex ? "active" : ""}`}>
              <i>{index + 1}</i>{player.label}{hasBall(player) && <b title="持有足球">●</b>}
            </div>
          );
        })}
        <span className="deck-count">牌库 {game.deck.length}<i />弃牌 {game.discard.length}</span>
      </nav>

      <div className="game-layout">
        <section className="pitch-panel">
          <div className="pitch-frame">
            <div className="pitch" role="grid" aria-label="8乘8足球棋盘">
              <div className="center-circle" aria-hidden="true" />
              <div className="halfway-line" aria-hidden="true" />
              {Array.from({ length: 64 }, (_, position) => {
                const player = game.players.find((item) => item.position === position);
                const goal = position === RED_GOAL ? "red" : position === BLUE_GOAL ? "blue" : null;
                const valid = validCells.has(position);
                const setupSelected = player?.id === setupPlayerId && (game.phase === "setup" || game.phase === "kickoff");
                const tackleTarget =
                  game.phase === "turn" &&
                  actionMode === "tackle" &&
                  player &&
                  player.team !== current.team &&
                  player.hand.length > 0;
                return (
                  <button
                    key={position}
                    className={`pitch-cell ${(Math.floor(position / 8) + position) % 2 ? "stripe" : ""} ${valid ? "valid" : ""} ${goal ? `goal ${goal}` : ""} ${tackleTarget ? "tackle-target" : ""}`}
                    onClick={() => handleCell(position)}
                    aria-label={`${squareName(position)}${player ? `，${player.label}` : ""}${goal ? `，${describeTeam(goal)}球门` : ""}`}
                    role="gridcell"
                  >
                    <span className="coordinate">{squareName(position)}</span>
                    {goal && <span className="goal-net"><i /><i /><i /></span>}
                    {player && (
                      <span className={`player-token ${player.team} ${setupSelected ? "selected" : ""} ${player.id === current.id ? "current" : ""}`}>
                        <span className="jersey">{player.label.slice(1)}</span>
                        <strong>{player.label}</strong>
                        <small>{player.hand.length} 手牌</small>
                        {hasBall(player) && <span className="ball" title="足球">●</span>}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="file-labels" aria-hidden="true">{FILES.map((file) => <span key={file}>{file}</span>)}</div>
          </div>
          <div className="pitch-legend">
            <span><i className="legend-dot available" />可选位置</span>
            <span><i className="legend-dot football" />足球（测试模式可见）</span>
            <span><i className="legend-dot goal" />e1 / e8 单格球门</span>
          </div>
        </section>

        <aside className="control-column">
          <section className="phase-card">
            <p className="section-label">MATCH DIRECTOR</p>
            <h2>{phaseCopy[0]}</h2>
            <p>{phaseCopy[1]}</p>
            <div className="phase-rule"><span>{game.phase === "pass-response" ? `${(game.pass?.responseIndex ?? 0) + 1}/5 · ${game.pass?.responseStep === "card" ? "1/2" : "2/2"}` : "LIVE"}</span><i /></div>
          </section>

          {(game.phase === "setup" || game.phase === "kickoff") && (
            <section className="action-card-panel">
              <div className="panel-title-row"><h3>布阵控制</h3><span>己方半场</span></div>
              <div className="formation-list">
                {game.players.map((player) => (
                  <button key={player.id} className={`${player.team} ${setupPlayerId === player.id ? "selected" : ""}`} onClick={() => setSetupPlayerId(player.id)}>
                    {player.label}<small>{squareName(player.position)}</small>
                  </button>
                ))}
              </div>
              <div className="action-row">
                <button className="secondary-action" onClick={resetPositions}>默认阵型</button>
                <button className="primary-action" onClick={startKickoff}>{game.phase === "setup" ? "开始比赛" : "确认开球"}</button>
              </div>
            </section>
          )}

          {game.phase === "turn" && (
            <section className="action-card-panel">
              <div className="panel-title-row"><h3>选择行动</h3><span>{current.team === game.offense ? "进攻方" : "防守方"}</span></div>
              <button className="draw-action" onClick={drawCardsForTurn}>
                <span>抽牌</span><strong>+{current.team === game.offense ? 2 : 3}</strong><small>立即结束回合</small>
              </button>
              {selectedCard && (
                <div className="mode-grid">
                  <button className={actionMode === "move" ? "active" : ""} onClick={() => { setActionMode("move"); setPayloadIds([]); }}>MOVE<small>按属性移动</small></button>
                  {current.team === game.offense && <button className={actionMode === "pass" ? "active" : ""} onClick={() => setActionMode("pass")}>PASS<small>倒扣并转移</small></button>}
                  {current.team !== game.offense && <button className={actionMode === "tackle" ? "active" : ""} onClick={() => setActionMode("tackle")}>TACKLE<small>抽取对方暗牌</small></button>}
                </div>
              )}
              {actionMode === "pass" && selectedCard && (
                <div className="pass-builder">
                  <p>选择至少一张要倒扣的牌。可以不包含足球。</p>
                  <div className="mini-hand">
                    {current.hand.filter((card) => card.id !== selectedCard.id).map((card) => (
                      <button key={card.id} className={`${card.kind} ${payloadIds.includes(card.id) ? "selected" : ""}`} onClick={() => togglePayload(card.id)}>
                        {card.kind === "ball" ? "●" : SUIT_INFO[card.suit].icon}
                      </button>
                    ))}
                  </div>
                  <button className="primary-action full" disabled={payloadIds.length === 0} onClick={confirmPass}>倒扣 {payloadIds.length} 张并发起 Pass</button>
                </div>
              )}
              {actionMode === "move" && <p className="action-hint">点击棋盘上的高亮空格。若持球者点击对方球门，将触发越位重开。</p>}
              {actionMode === "tackle" && <p className="action-hint">点击棋盘上的任意对方球员。抽取目标的一张随机暗牌。</p>}
            </section>
          )}

          {game.phase === "pass-response" && responderId && (
            <section className="action-card-panel">
              <div className="panel-title-row"><h3>{playerById(game, responderId).label} 的选择</h3><span>{game.pass?.responseStep === "card" ? "步骤 1 / 按牌移动" : "步骤 2 / 弃牌冲刺"}</span></div>
              <div className="response-step-tabs">
                <span className={game.pass?.responseStep === "card" ? "active" : "done"}>1　按牌移动</span>
                <span className={game.pass?.responseStep === "discard" ? "active" : ""}>2　弃牌冲刺</span>
              </div>
              <p className="action-hint">
                {game.pass?.responseStep === "card"
                  ? "选择一张行动牌后点击棋盘高亮位置；完成后仍可继续弃牌冲刺。"
                  : "选择任意数量行动牌后点击棋盘高亮位置；移动步数等于弃牌数。"}
              </p>
              <div className="mini-hand large">
                {playerById(game, responderId).hand.filter((card) => card.kind === "action").map((card) => (
                  <button key={card.id} className={`action ${responseIds.includes(card.id) ? "selected" : ""}`} onClick={() => toggleResponseCard(card.id)}>
                    {card.kind === "action" && SUIT_INFO[card.suit].icon}<small>{card.kind === "action" && SUIT_INFO[card.suit].name}</small>
                  </button>
                ))}
              </div>
              <div className="response-actions two-step">
                <span className={responseIds.length > 0 ? "ready" : ""}>
                  {responseIds.length > 0
                    ? game.pass?.responseStep === "card"
                      ? "已选 1 张 · 点击高亮位置"
                      : `已选 ${responseIds.length} 张 · 点击高亮位置`
                    : "尚未选择行动牌"}
                </span>
                <button onClick={skipResponseStep}>{game.pass?.responseStep === "card" ? "跳过第 1 步" : "完成响应"}</button>
              </div>
              {responseIds.length > 0 && <p className="action-hint accent">现在点击棋盘上的高亮空格完成本步骤。</p>}
            </section>
          )}

          {game.phase === "pass-target" && game.pass && (
            <section className="action-card-panel pass-summary">
              <div className="panel-title-row"><h3>倒扣组合</h3><span>{game.pass.payload.length} 张</span></div>
              <div className="facedown-row">{game.pass.payload.map((card) => <span key={card.id}>PASS</span>)}</div>
              <p>传球属性：<strong>{SUIT_INFO[game.pass.actionCard.suit].name}</strong>。棋盘上已标出全部合法目标。</p>
            </section>
          )}

          {game.phase === "intercept" && game.pass && (
            <section className="action-card-panel intercept-panel">
              <div className="panel-title-row"><h3>选择一张截获</h3><span>已揭开</span></div>
              <div className="revealed-hand">
                {game.pass.payload.map((card) => (
                  <button key={card.id} className={card.kind} onClick={() => chooseInterceptCard(card.id)}>
                    <strong>{card.kind === "ball" ? "●" : SUIT_INFO[card.suit].icon}</strong>
                    <span>{card.kind === "ball" ? "FOOTBALL" : SUIT_INFO[card.suit].name}</span>
                    <small>{card.kind === "ball" ? "选中即交换攻防" : SUIT_INFO[card.suit].caption}</small>
                  </button>
                ))}
              </div>
            </section>
          )}

          {game.phase === "discard" && (
            <section className="action-card-panel">
              <div className="panel-title-row"><h3>弃至上限</h3><span>{focusPlayer.hand.length} / {handLimit(game, focusPlayer)}</span></div>
              <div className="revealed-hand compact">
                {focusPlayer.hand.map((card) => (
                  <button key={card.id} className={card.kind} disabled={card.kind === "ball"} onClick={() => discardOverflow(card.id)}>
                    <strong>{card.kind === "ball" ? "●" : SUIT_INFO[card.suit].icon}</strong>
                    <span>{card.kind === "ball" ? "FOOTBALL" : SUIT_INFO[card.suit].name}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {game.phase === "gameover" && (
            <section className={`winner-card ${game.winner}`}>
              <span>FULL TIME</span><strong>{game.scores.red} — {game.scores.blue}</strong>
              <button onClick={() => { setGame(createGame()); clearSelections(); setSetupPlayerId("r1"); }}>再来一局</button>
            </section>
          )}

          <section className="match-log">
            <div className="panel-title-row"><h3>比赛记录</h3><span>最新在前</span></div>
            <div className="log-scroll">
              {game.log.map((message, index) => <p key={`${message}-${index}`}><i>{String(game.log.length - index).padStart(2, "0")}</i>{message}</p>)}
            </div>
          </section>
        </aside>
      </div>

      <section className="hand-dock" aria-label={`${focusPlayer.label} 手牌`}>
        <div className="hand-owner">
          <span className={`owner-badge ${focusPlayer.team}`}>{focusPlayer.label}</span>
          <div><strong>当前手牌</strong><small>单人测试模式：所有手牌均可查看</small></div>
          <b>{focusPlayer.hand.length} / {handLimit(game, focusPlayer)}</b>
        </div>
        <div className="card-fan">
          {focusPlayer.hand.map((card) => {
            const isCurrentTurnCard = game.phase === "turn" && focusPlayer.id === current.id;
            const selected = isCurrentTurnCard && selectedCardId === card.id;
            return (
              <button
                key={card.id}
                className={`play-card ${card.kind} ${selected ? "selected" : ""}`}
                disabled={!isCurrentTurnCard || card.kind === "ball"}
                onClick={() => {
                  if (card.kind !== "action") return;
                  setSelectedCardId(selected ? null : card.id);
                  setActionMode(null);
                  setPayloadIds([]);
                }}
              >
                <span className="card-corner">{card.kind === "ball" ? "BALL" : SUIT_INFO[card.suit].name}</span>
                <strong>{card.kind === "ball" ? "●" : SUIT_INFO[card.suit].icon}</strong>
                <h4>{card.kind === "ball" ? "FOOTBALL" : SUIT_INFO[card.suit].caption}</h4>
                <small>{card.kind === "ball" ? "不能弃置 · 可随 Pass 转移" : "MOVE · PASS · TACKLE"}</small>
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
