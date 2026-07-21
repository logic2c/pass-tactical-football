"use client";

import { useEffect, useState } from "react";
import {
  closestDistance,
  goalDistance,
  gridDistance,
  progressGain,
  weightedAiChoice,
  type AiCandidate,
  type AiSelection,
} from "./ai";
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
  aiNote?: string;
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

// 首轮平衡参数集中在这里，后续改规则时不需要进入 AI 状态机逐处修改。
const GAME_BALANCE = {
  actionCardsPerSuit: 20,
  startingHand: 3,
  draw: { offense: 2, defense: 3 },
  handLimit: { offense: 5, defense: 6 },
  winningScore: 3,
} as const;

const AI_TUNING = {
  turnTemperature: 2.15,
  detailTemperature: 1.6,
  responseTemperature: 1.75,
  interceptTemperature: 1.55,
  discardTemperature: 1.45,
  thinkDelay: { turn: 820, phase: 560 },
} as const;

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
      Array.from({ length: GAME_BALANCE.actionCardsPerSuit }, (_, index) => ({
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

  game.players.forEach((player) => drawInto(game, player, GAME_BALANCE.startingHand));
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
  return player.team === game.offense ? GAME_BALANCE.handLimit.offense : GAME_BALANCE.handLimit.defense;
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

type AiTurnPlan =
  | { kind: "draw" }
  | { kind: "move"; cardId: string; position: number }
  | { kind: "tackle"; cardId: string; targetId: string }
  | { kind: "pass"; cardId: string; payloadIds: string[] };

function actionCards(player: Player) {
  return player.hand.filter((card): card is ActionCard => card.kind === "action");
}

function otherTeam(team: Team): Team {
  return team === "red" ? "blue" : "red";
}

function cardPreservationPenalty(player: Player, card: ActionCard) {
  const sameSuit = actionCards(player).filter((item) => item.suit === card.suit).length;
  return sameSuit <= 1 ? 1.1 : sameSuit === 2 ? 0.45 : 0.1;
}

function passBlockers(game: GameState, passer: Player, target: number, suit: Suit) {
  const path = passPath(passer.position, target, suit) ?? [];
  return path
    .map((cell) => game.players.find((player) => player.position === cell && player.team !== passer.team))
    .filter((player): player is Player => Boolean(player));
}

function logAiSelection<T>(game: GameState, player: Player, selection: AiSelection<T>, label: string) {
  const probability = Math.max(1, Math.round(selection.probability * 100));
  const note = `${player.label} · ${label}：${selection.reason}（本次权重 ${probability}%）`;
  game.aiNote = note;
  addLog(game, `AI 判断：${note}`);
}

function phaseActorId(game: GameState) {
  if (game.phase === "turn") return activePlayer(game).id;
  if (game.phase === "pass-response" && game.pass) {
    return game.pass.responders[game.pass.responseIndex];
  }
  if (game.phase === "pass-target" && game.pass) return game.pass.passerId;
  if (game.phase === "intercept" && game.pass?.blockerId) return game.pass.blockerId;
  if (game.phase === "discard") return game.discardQueue[0];
  return undefined;
}

function beginPassAction(game: GameState, cardId: string, payloadIds: string[]) {
  const passer = activePlayer(game);
  if (passer.team !== game.offense) return false;
  const actionIndex = passer.hand.findIndex((card) => card.id === cardId && card.kind === "action");
  const validPayloadIds = payloadIds.filter((id) => id !== cardId && passer.hand.some((card) => card.id === id));
  if (actionIndex < 0 || validPayloadIds.length === 0) return false;

  const [passCard] = passer.hand.splice(actionIndex, 1) as ActionCard[];
  game.discard.push(passCard);
  const payload: GameCard[] = [];
  validPayloadIds.forEach((id) => {
    const index = passer.hand.findIndex((card) => card.id === id);
    if (index >= 0) payload.push(...passer.hand.splice(index, 1));
  });
  if (payload.length === 0) return false;

  const startIndex = TURN_ORDER.indexOf(passer.id);
  const responders = Array.from({ length: TURN_ORDER.length - 1 }, (_, index) =>
    TURN_ORDER[(startIndex + index + 1) % TURN_ORDER.length],
  );
  game.pass = {
    passerId: passer.id,
    actionCard: passCard,
    payload,
    responders,
    responseIndex: 0,
    responseStep: "card",
  };
  game.phase = "pass-response";
  addLog(game, `${passer.label} 发起 ${SUIT_INFO[passCard.suit].name} Pass，倒扣 ${payload.length} 张牌。`);
  return true;
}

function advancePassResponse(game: GameState) {
  if (!game.pass) return;
  game.pass.responseIndex += 1;
  game.pass.responseStep = "card";
  if (game.pass.responseIndex >= game.pass.responders.length) {
    const passer = playerById(game, game.pass.passerId);
    if (passTargets(game).size === 0) {
      const defendingTeam = otherTeam(passer.team);
      const chooserId = nextOpponent(game, passer.id, defendingTeam);
      game.pass.blockerId = chooserId;
      game.phase = "intercept";
      addLog(game, `场上没有合法传球目标，倒扣牌揭开，由 ${playerById(game, chooserId).label} 选择一张。`);
    } else {
      game.phase = "pass-target";
      addLog(game, `${passer.label} 现在必须选择传球目标。`);
    }
  }
}

function resolvePassAt(game: GameState, position: number) {
  const state = game.pass;
  if (!state || !passTargets(game).has(position)) return false;
  const passer = playerById(game, state.passerId);
  const path = passPath(passer.position, position, state.actionCard.suit);
  if (!path) return false;
  const blockers = path
    .map((cell) => game.players.find((player) => player.position === cell && player.team !== passer.team))
    .filter((player): player is Player => Boolean(player));

  if (blockers.length > 0) {
    state.blockerId = blockers[0].id;
    state.targetId = isGoal(position)
      ? `goal-${passer.team === "red" ? "blue" : "red"}`
      : game.players.find((player) => player.position === position)?.id;
    game.phase = "intercept";
    addLog(game, `${blockers[0].label} 截断了传球路线，倒扣牌全部揭开。`);
    return true;
  }

  if (position === enemyGoal(passer.team)) {
    const scoringTeam = passer.team;
    game.scores[scoringTeam] += 1;
    const payloadActions = state.payload.filter((card): card is ActionCard => card.kind === "action");
    game.discard.push(...payloadActions);
    addLog(game, `${passer.label} 将足球传入 ${squareName(position)}！${describeTeam(scoringTeam)}得分。`);
    if (game.scores[scoringTeam] >= GAME_BALANCE.winningScore) {
      game.phase = "gameover";
      game.winner = scoringTeam;
      game.pass = undefined;
      return true;
    }
    const receiverId = nextOpponent(game, passer.id, otherTeam(scoringTeam));
    kickoff(game, receiverId, "进球后开球：", passer.id);
    return true;
  }

  const recipient = game.players.find((player) => player.position === position);
  if (!recipient || recipient.team !== passer.team) return false;
  recipient.hand.push(...state.payload);
  addLog(game, `${passer.label} 成功把 ${cardSummary(state.payload)} 交给 ${recipient.label}。`);
  game.pass = undefined;
  finishAction(game);
  return true;
}

function takeInterceptCard(game: GameState, cardId: string) {
  const state = game.pass;
  if (!state?.blockerId) return false;
  const cardIndex = state.payload.findIndex((card) => card.id === cardId);
  if (cardIndex < 0) return false;
  const [chosen] = state.payload.splice(cardIndex, 1);
  const blocker = playerById(game, state.blockerId);
  const passer = playerById(game, state.passerId);
  blocker.hand.push(chosen);
  passer.hand.push(...state.payload);
  if (chosen.kind === "ball") {
    game.offense = blocker.team;
    addLog(game, `${blocker.label} 从传球组合中选走足球，${describeTeam(blocker.team)}转为进攻。`);
  } else {
    addLog(game, `${blocker.label} 选走一张 ${SUIT_INFO[chosen.suit].name}；足球若在组合中则回到 ${passer.label}。`);
  }
  game.pass = undefined;
  finishAction(game);
  return true;
}

function discardOverflowAction(game: GameState, cardId: string) {
  const playerId = game.discardQueue[0];
  if (!playerId) return false;
  const player = playerById(game, playerId);
  const index = player.hand.findIndex((card) => card.id === cardId && card.kind === "action");
  if (index < 0) return false;
  const [card] = player.hand.splice(index, 1) as ActionCard[];
  game.discard.push(card);
  addLog(game, `${player.label} 弃掉一张 ${SUIT_INFO[card.suit].name}。`);
  if (player.hand.length <= handLimit(game, player)) game.discardQueue.shift();
  if (game.discardQueue.length === 0) {
    if (game.discardResume === "kickoff") {
      game.phase = "kickoff";
      game.discardResume = undefined;
      addLog(game, "手牌已处理完毕，可以重新布阵并开球。");
    } else {
      nextTurn(game);
    }
  }
  return true;
}

function scoreMove(game: GameState, player: Player, position: number, card: ActionCard) {
  const ballHolder = game.players.find(hasBall);
  const enemies = game.players.filter((item) => item.team !== player.team).map((item) => item.position);
  const preservation = cardPreservationPenalty(player, card);
  if (player.team === game.offense) {
    const progress = progressGain(player.team, player.position, position);
    const safety = Math.min(3, closestDistance(position, enemies));
    const createsShotLine = actionCards(player).some((item) => passPath(position, enemyGoal(player.team), item.suit));
    const supportsBall = ballHolder && ballHolder.id !== player.id
      ? gridDistance(player.position, ballHolder.position) - gridDistance(position, ballHolder.position)
      : 0;
    return 1.2 + progress * (hasBall(player) ? 1.7 : 0.85) + safety * (hasBall(player) ? 0.55 : 0.15)
      + supportsBall * 0.35 + (createsShotLine ? 1.8 : 0) - preservation;
  }
  const ballPosition = ballHolder?.position ?? enemyGoal(otherTeam(player.team));
  const closesBall = gridDistance(player.position, ballPosition) - gridDistance(position, ballPosition);
  const protectsGoal = goalDistance(otherTeam(player.team), player.position) - goalDistance(otherTeam(player.team), position);
  return 1 + closesBall * 1.35 + protectsGoal * 0.35 - preservation;
}

function scorePassPlan(game: GameState, passer: Player, card: ActionCard, payloadIds: string[]) {
  const carriesBall = payloadIds.includes("football");
  const possibleScores: number[] = [];
  game.players
    .filter((player) => player.team === passer.team && player.id !== passer.id)
    .forEach((recipient) => {
      if (!passPath(passer.position, recipient.position, card.suit)) return;
      const blockers = passBlockers(game, passer, recipient.position, card.suit).length;
      const progress = progressGain(passer.team, passer.position, recipient.position);
      possibleScores.push(
        (carriesBall ? 5 + progress * 1.65 : 1.8 + Math.max(0, 3 - recipient.hand.length) * 0.5)
          - blockers * (carriesBall ? 9 : 1.5),
      );
    });
  if (carriesBall && passPath(passer.position, enemyGoal(passer.team), card.suit)) {
    const blockers = passBlockers(game, passer, enemyGoal(passer.team), card.suit).length;
    possibleScores.push(19 - blockers * 10);
  }
  const bestTarget = possibleScores.length > 0 ? Math.max(...possibleScores) : -3.5;
  const supportCards = payloadIds.filter((id) => id !== "football").length;
  return bestTarget + (carriesBall ? 0.8 : -0.4) + Math.min(1, supportCards) * 0.25;
}

function runAiTurn(game: GameState) {
  const player = activePlayer(game);
  const cards = actionCards(player);
  const turnChoices: AiCandidate<AiTurnPlan>[] = [];
  const drawScore = cards.length <= 1 ? 9 : cards.length === 2 ? 5.2 : player.hand.length < handLimit(game, player) ? 1.6 : -3;
  turnChoices.push({ value: { kind: "draw" }, score: drawScore, reason: cards.length <= 1 ? "手牌不足，优先补充选择" : "保留节奏并补充手牌" });

  const movePlans: AiCandidate<AiTurnPlan>[] = [];
  cards.forEach((card) => {
    movementTargets(game, player, card.suit).forEach((position) => {
      if (position === enemyGoal(player.team)) return;
      const score = scoreMove(game, player, position, card);
      movePlans.push({
        value: { kind: "move", cardId: card.id, position },
        score,
        reason: player.team === game.offense
          ? `向 ${squareName(position)} 推进并寻找传球线路`
          : `移动到 ${squareName(position)} 压缩持球队空间`,
      });
    });
  });
  const moveChoice = weightedAiChoice(movePlans, AI_TUNING.detailTemperature);
  if (moveChoice) turnChoices.push({ value: moveChoice.value, score: moveChoice.score, reason: moveChoice.reason });

  if (player.team !== game.offense && cards.length > 0) {
    const tacklePlans: AiCandidate<AiTurnPlan>[] = [];
    const targets = game.players.filter((target) => target.team !== player.team && target.hand.length > 0);
    cards.forEach((card) => {
      targets.forEach((target) => {
        const chance = hasBall(target) ? 1 / target.hand.length : 0;
        const score = 2.2 + chance * 12 + (hasBall(target) ? 3.5 : 0) - cardPreservationPenalty(player, card);
        tacklePlans.push({
          value: { kind: "tackle", cardId: card.id, targetId: target.id },
          score,
          reason: hasBall(target)
            ? `压迫持球者 ${target.label}，抢到球的估计概率 ${Math.round(chance * 100)}%`
            : `试探 ${target.label} 的手牌`,
        });
      });
    });
    const tackleChoice = weightedAiChoice(tacklePlans, AI_TUNING.detailTemperature);
    if (tackleChoice) turnChoices.push({ value: tackleChoice.value, score: tackleChoice.score, reason: tackleChoice.reason });
  }

  if (player.team === game.offense && cards.length > 0 && player.hand.length > 1) {
    const passPlans: AiCandidate<AiTurnPlan>[] = [];
    cards.forEach((card) => {
      const remainingActions = cards
        .filter((item) => item.id !== card.id)
        .sort((left, right) => cardPreservationPenalty(player, left) - cardPreservationPenalty(player, right));
      const payloadPlans: string[][] = [];
      if (hasBall(player)) {
        payloadPlans.push(["football"]);
        if (remainingActions[0]) {
          payloadPlans.push(["football", remainingActions[0].id]);
          payloadPlans.push([remainingActions[0].id]);
        }
      } else if (remainingActions[0]) {
        payloadPlans.push([remainingActions[0].id]);
      }
      payloadPlans.forEach((payload) => {
        const score = scorePassPlan(game, player, card, payload);
        passPlans.push({
          value: { kind: "pass", cardId: card.id, payloadIds: payload },
          score,
          reason: payload.includes("football") ? "尝试推进足球并制造射门线路" : "用佯攻调动全场站位",
        });
      });
    });
    const passChoice = weightedAiChoice(passPlans, AI_TUNING.detailTemperature);
    if (passChoice) turnChoices.push({ value: passChoice.value, score: passChoice.score, reason: passChoice.reason });
  }

  const selection = weightedAiChoice(turnChoices, AI_TUNING.turnTemperature);
  if (!selection) return;
  const plan = selection.value;
  const labels = { draw: "抽牌", move: "移动", tackle: "抢断", pass: "传球" };
  logAiSelection(game, player, selection, labels[plan.kind]);

  if (plan.kind === "draw") {
    const count = player.team === game.offense ? GAME_BALANCE.draw.offense : GAME_BALANCE.draw.defense;
    drawInto(game, player, count);
    addLog(game, `${player.label} 选择抽牌，获得 ${count} 张行动牌。`);
    finishAction(game);
    return;
  }
  if (plan.kind === "move") {
    const index = player.hand.findIndex((card) => card.id === plan.cardId && card.kind === "action");
    if (index < 0) return finishAction(game);
    const [used] = player.hand.splice(index, 1) as ActionCard[];
    game.discard.push(used);
    player.position = plan.position;
    addLog(game, `${player.label} 使用 ${SUIT_INFO[used.suit].name} 移动到 ${squareName(player.position)}。`);
    finishAction(game);
    return;
  }
  if (plan.kind === "tackle") {
    const index = player.hand.findIndex((card) => card.id === plan.cardId && card.kind === "action");
    const target = playerById(game, plan.targetId);
    if (index < 0 || target.hand.length === 0) return finishAction(game);
    const [used] = player.hand.splice(index, 1) as ActionCard[];
    game.discard.push(used);
    const takenIndex = Math.floor(Math.random() * target.hand.length);
    const [taken] = target.hand.splice(takenIndex, 1);
    player.hand.push(taken);
    if (taken.kind === "ball") {
      game.offense = player.team;
      addLog(game, `${player.label} 抢断 ${target.label} 并抽中足球！${describeTeam(player.team)}转为进攻。`);
    } else {
      addLog(game, `${player.label} 抢断 ${target.label}，抽到一张 ${SUIT_INFO[taken.suit].name}。`);
    }
    finishAction(game);
    return;
  }
  beginPassAction(game, plan.cardId, plan.payloadIds);
}

function responsePositionScore(game: GameState, responder: Player, position: number) {
  const state = game.pass;
  if (!state) return 0;
  const passer = playerById(game, state.passerId);
  if (responder.team === passer.team) {
    const becomesTarget = passPath(passer.position, position, state.actionCard.suit) ? 6.5 : 0;
    return becomesTarget + progressGain(responder.team, responder.position, position) * 0.8;
  }
  const targetPositions = game.players
    .filter((player) => player.team === passer.team && player.id !== passer.id)
    .map((player) => player.position);
  targetPositions.push(enemyGoal(passer.team));
  const blockedRoutes = targetPositions.filter((target) =>
    (passPath(passer.position, target, state.actionCard.suit) ?? []).includes(position),
  ).length;
  const pressure = gridDistance(responder.position, passer.position) - gridDistance(position, passer.position);
  return blockedRoutes * 7 + pressure * 0.65;
}

function runAiResponse(game: GameState) {
  const state = game.pass;
  if (!state) return;
  const responder = playerById(game, state.responders[state.responseIndex]);
  if (state.responseStep === "card") {
    type CardResponse = { kind: "skip" } | { kind: "move"; cardId: string; position: number };
    const options: AiCandidate<CardResponse>[] = [{
      value: { kind: "skip" },
      score: actionCards(responder).length <= 1 ? 4.5 : 1.2,
      reason: actionCards(responder).length <= 1 ? "保留最后的行动牌" : "保持当前位置",
    }];
    actionCards(responder).forEach((card) => {
      movementTargets(game, responder, card.suit).forEach((position) => {
        if (position === enemyGoal(responder.team)) return;
        options.push({
          value: { kind: "move", cardId: card.id, position },
          score: responsePositionScore(game, responder, position) - cardPreservationPenalty(responder, card),
          reason: responder.team === playerById(game, state.passerId).team
            ? `移动到 ${squareName(position)} 接应传球`
            : `移动到 ${squareName(position)} 封锁线路`,
        });
      });
    });
    const choice = weightedAiChoice(options, AI_TUNING.responseTemperature);
    if (choice) {
      const responseChoice = choice.value;
      logAiSelection(game, responder, choice, "响应第 1 步");
      if (responseChoice.kind === "move") {
        const index = responder.hand.findIndex((card) => card.id === responseChoice.cardId && card.kind === "action");
        if (index >= 0) {
          const [used] = responder.hand.splice(index, 1) as ActionCard[];
          game.discard.push(used);
          responder.position = responseChoice.position;
          addLog(game, `${responder.label} 在响应中使用 ${SUIT_INFO[used.suit].name} 移动到 ${squareName(responder.position)}。`);
        }
      } else {
        addLog(game, `${responder.label} 跳过按牌移动。`);
      }
    }
    if (game.pass) game.pass.responseStep = "discard";
  }

  if (!game.pass || game.pass.responseStep !== "discard") return;
  type SprintResponse = { kind: "skip" } | { kind: "sprint"; cardIds: string[]; position: number };
  const remaining = actionCards(responder).sort(
    (left, right) => cardPreservationPenalty(responder, left) - cardPreservationPenalty(responder, right),
  );
  const sprintOptions: AiCandidate<SprintResponse>[] = [{
    value: { kind: "skip" },
    score: remaining.length <= 2 ? 4 : 1.8,
    reason: remaining.length <= 2 ? "避免耗尽手牌" : "当前站位已经足够",
  }];
  for (let distance = 1; distance <= Math.min(3, remaining.length); distance += 1) {
    const cardIds = remaining.slice(0, distance).map((card) => card.id);
    sprintTargets(game, responder, distance).forEach((position) => {
      if (position === enemyGoal(responder.team)) return;
      sprintOptions.push({
        value: { kind: "sprint", cardIds, position },
        score: responsePositionScore(game, responder, position) - distance * 1.35,
        reason: responder.team === playerById(game, game.pass!.passerId).team
          ? `冲刺到 ${squareName(position)} 提供接应`
          : `冲刺到 ${squareName(position)} 加强封堵`,
      });
    });
  }
  const sprintChoice = weightedAiChoice(sprintOptions, AI_TUNING.responseTemperature);
  if (sprintChoice) {
    logAiSelection(game, responder, sprintChoice, "响应第 2 步");
    if (sprintChoice.value.kind === "sprint") {
      const discarded: ActionCard[] = [];
      sprintChoice.value.cardIds.forEach((id) => {
        const index = responder.hand.findIndex((card) => card.id === id && card.kind === "action");
        if (index >= 0) discarded.push(...(responder.hand.splice(index, 1) as ActionCard[]));
      });
      game.discard.push(...discarded);
      responder.position = sprintChoice.value.position;
      addLog(game, `${responder.label} 弃掉 ${discarded.length} 张牌，冲刺到 ${squareName(responder.position)}。`);
    } else {
      addLog(game, `${responder.label} 完成响应并保留手牌。`);
    }
  }
  advancePassResponse(game);
}

function runAiPassTarget(game: GameState, humanPlayerId: string) {
  const state = game.pass;
  if (!state) return;
  const passer = playerById(game, state.passerId);
  const carriesBall = state.payload.some((card) => card.kind === "ball");
  const choices: AiCandidate<number>[] = [];
  passTargets(game).forEach((position) => {
    const blockers = passBlockers(game, passer, position, state.actionCard.suit).length;
    if (position === enemyGoal(passer.team)) {
      choices.push({ value: position, score: 21 - blockers * 11, reason: blockers ? "尝试有风险的射门" : "获得清晰射门机会" });
      return;
    }
    const recipient = game.players.find((player) => player.position === position)!;
    const progress = progressGain(passer.team, passer.position, recipient.position);
    const score = (carriesBall ? 5 + progress * 1.7 : 2 + Math.max(0, 3 - recipient.hand.length) * 0.55)
      - blockers * (carriesBall ? 9 : 1.5) + (recipient.id === humanPlayerId ? 0.8 : 0);
    choices.push({
      value: position,
      score,
      reason: carriesBall ? `把球推进给 ${recipient.label}` : `把资源转移给 ${recipient.label}`,
    });
  });
  const choice = weightedAiChoice(choices, AI_TUNING.detailTemperature);
  if (!choice) return;
  logAiSelection(game, passer, choice, "选择传球目标");
  resolvePassAt(game, choice.value);
}

function runAiIntercept(game: GameState) {
  const state = game.pass;
  if (!state?.blockerId) return;
  const blocker = playerById(game, state.blockerId);
  const suitCounts = new Map<Suit, number>();
  actionCards(blocker).forEach((card) => suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1));
  const choices: AiCandidate<string>[] = state.payload.map((card) => ({
    value: card.id,
    score: card.kind === "ball" ? 9.5 : 2.5 + (suitCounts.get(card.suit) === 0 ? 1.2 : 0),
    reason: card.kind === "ball" ? "优先夺取球权" : `补充 ${SUIT_INFO[card.suit].name} 线路`,
  }));
  const choice = weightedAiChoice(choices, AI_TUNING.interceptTemperature);
  if (!choice) return;
  logAiSelection(game, blocker, choice, "选择截获牌");
  takeInterceptCard(game, choice.value);
}

function runAiDiscard(game: GameState) {
  const playerId = game.discardQueue[0];
  if (!playerId) return;
  const player = playerById(game, playerId);
  let safety = 12;
  while (player.hand.length > handLimit(game, player) && safety > 0) {
    safety -= 1;
    const cards = actionCards(player);
    const counts = new Map<Suit, number>();
    cards.forEach((card) => counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1));
    const choices: AiCandidate<string>[] = cards.map((card) => ({
      value: card.id,
      score: (counts.get(card.suit) ?? 1) * 1.4 - cardPreservationPenalty(player, card),
      reason: `弃置重复较多的 ${SUIT_INFO[card.suit].name}`,
    }));
    const choice = weightedAiChoice(choices, AI_TUNING.discardTemperature);
    if (!choice) break;
    logAiSelection(game, player, choice, "处理手牌上限");
    discardOverflowAction(game, choice.value);
  }
}

function runAiStep(game: GameState, humanPlayerId: string) {
  const actorId = phaseActorId(game);
  if (!actorId || actorId === humanPlayerId) return false;
  if (game.phase === "turn") runAiTurn(game);
  else if (game.phase === "pass-response") runAiResponse(game);
  else if (game.phase === "pass-target") runAiPassTarget(game, humanPlayerId);
  else if (game.phase === "intercept") runAiIntercept(game);
  else if (game.phase === "discard") runAiDiscard(game);
  else return false;
  return true;
}

export default function Home() {
  const [game, setGame] = useState<GameState>(() => createGame());
  const [humanPlayerId, setHumanPlayerId] = useState("r1");
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
        : game.phase === "intercept" && game.pass?.blockerId
          ? playerById(game, game.pass.blockerId)
        : current;
  const actorId = phaseActorId(game);
  const aiThinking = Boolean(actorId && actorId !== humanPlayerId);
  const humanTurn = game.phase === "turn" && current.id === humanPlayerId;
  const focusIsHuman = focusPlayer.id === humanPlayerId;

  useEffect(() => {
    if (!actorId || actorId === humanPlayerId) return;
    const delay = game.phase === "turn" ? AI_TUNING.thinkDelay.turn : AI_TUNING.thinkDelay.phase;
    const timer = window.setTimeout(() => {
      setGame((previous) => {
        const expectedActor = phaseActorId(previous);
        if (!expectedActor || expectedActor === humanPlayerId || expectedActor !== actorId) return previous;
        const next = structuredClone(previous);
        return runAiStep(next, humanPlayerId) ? next : previous;
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [game, actorId, humanPlayerId]);

  const selectedCard = current.hand.find(
    (card): card is ActionCard => card.id === selectedCardId && card.kind === "action",
  );

  const validCells = (() => {
    if (game.phase === "turn" && current.id === humanPlayerId && actionMode === "move" && selectedCard) {
      return movementTargets(game, current, selectedCard.suit);
    }
    if (game.phase === "pass-target" && game.pass?.passerId === humanPlayerId) return passTargets(game);
    if (game.phase === "pass-response" && responderId === humanPlayerId && game.pass) {
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
  })();

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
    setSetupPlayerId(humanPlayerId);
  }

  function chooseHumanPlayer(playerId: string) {
    if (game.phase !== "setup") return;
    setHumanPlayerId(playerId);
    setSetupPlayerId(playerId);
    clearSelections();
  }

  function drawCardsForTurn() {
    if (!humanTurn) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const player = activePlayer(next);
      if (player.id !== humanPlayerId) return previous;
      const count = player.team === next.offense ? GAME_BALANCE.draw.offense : GAME_BALANCE.draw.defense;
      drawInto(next, player, count);
      addLog(next, `${player.label} 选择抽牌，获得 ${count} 张行动牌。`);
      finishAction(next);
      return next;
    });
    clearSelections();
  }

  function performMove(position: number) {
    if (!humanTurn || !selectedCard || !validCells.has(position)) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const player = activePlayer(next);
      if (player.id !== humanPlayerId) return previous;
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
    if (!humanTurn || !selectedCard || actionMode !== "tackle") return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const player = activePlayer(next);
      if (player.id !== humanPlayerId) return previous;
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
    if (!humanTurn || !selectedCard || payloadIds.length === 0) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      if (activePlayer(next).id !== humanPlayerId) return previous;
      return beginPassAction(next, selectedCard.id, payloadIds) ? next : previous;
    });
    clearSelections();
  }

  function skipResponseStep() {
    if (responderId !== humanPlayerId) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      if (!next.pass) return previous;
      const responder = playerById(next, next.pass.responders[next.pass.responseIndex]);
      if (responder.id !== humanPlayerId) return previous;
      if (next.pass.responseStep === "card") {
        next.pass.responseStep = "discard";
        addLog(next, `${responder.label} 跳过按牌移动，进入弃牌冲刺步骤。`);
      } else {
        addLog(next, `${responder.label} 完成响应移动。`);
        advancePassResponse(next);
      }
      return next;
    });
    setResponseIds([]);
  }

  function performResponseMove(position: number) {
    if (!responderId || responderId !== humanPlayerId || !game.pass || !validCells.has(position)) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      if (!next.pass) return previous;
      const passerId = next.pass.passerId;
      const responder = playerById(next, next.pass.responders[next.pass.responseIndex]);
      if (responder.id !== humanPlayerId) return previous;
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
        advancePassResponse(next);
      } else {
        return previous;
      }
      return next;
    });
    setResponseIds([]);
  }

  function resolvePass(position: number) {
    if (!game.pass || game.pass.passerId !== humanPlayerId || !validCells.has(position)) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      if (next.pass?.passerId !== humanPlayerId) return previous;
      return resolvePassAt(next, position) ? next : previous;
    });
    clearSelections();
  }

  function chooseInterceptCard(cardId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      if (next.pass?.blockerId !== humanPlayerId) return previous;
      return takeInterceptCard(next, cardId) ? next : previous;
    });
    clearSelections();
  }

  function discardOverflow(cardId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      if (next.discardQueue[0] !== humanPlayerId) return previous;
      return discardOverflowAction(next, cardId) ? next : previous;
    });
  }

  function handleCell(position: number) {
    const occupant = game.players.find((player) => player.position === position);
    if (game.phase === "setup" || game.phase === "kickoff") {
      if (occupant) {
        if (occupant.id === humanPlayerId) setSetupPlayerId(occupant.id);
        return;
      }
      const player = playerById(game, setupPlayerId);
      if (!player || player.id !== humanPlayerId || !isOwnHalf(player, position) || isGoal(position)) return;
      setGame((previous) => {
        const next = structuredClone(previous);
        playerById(next, setupPlayerId).position = position;
        return next;
      });
      return;
    }
    if (game.phase === "turn" && current.id === humanPlayerId && actionMode === "move") {
      performMove(position);
      return;
    }
    if (game.phase === "turn" && current.id === humanPlayerId && actionMode === "tackle" && occupant) {
      performTackle(occupant.id);
      return;
    }
    if (game.phase === "pass-response" && responderId === humanPlayerId && responseIds.length > 0) {
      performResponseMove(position);
      return;
    }
    if (game.phase === "pass-target" && game.pass?.passerId === humanPlayerId) resolvePass(position);
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
    if (game.phase === "setup") return ["选择角色并布阵", "选择你控制的一名球员；其余五名球员由 AI 控制。"];
    if (game.phase === "kickoff") return [game.kickoffReason, "AI 已回到默认阵型；你可以调整自己球员的位置后确认开球。"];
    if (game.phase === "turn") return current.id === humanPlayerId
      ? [`${current.label} · 你的回合`, "选择抽牌，或选择一张行动牌执行一个合法行动。"]
      : [`${current.label} · AI 回合`, "AI 正根据推进、球权、线路与手牌收益进行加权选择。"];
    if (game.phase === "pass-response" && responderId && game.pass)
      return responderId !== humanPlayerId
        ? [`${playerById(game, responderId).label} · AI 响应`, "AI 正在权衡接应、封线和保留手牌。"]
        : game.pass.responseStep === "card"
        ? [`${playerById(game, responderId).label} · 响应第 1 步`, "选择一张牌按属性移动，或跳过并进入弃牌冲刺。"]
        : [`${playerById(game, responderId).label} · 响应第 2 步`, "可弃任意数量行动牌横纵冲刺相同步数，也可以直接完成响应。"];
    if (game.phase === "pass-target") return game.pass?.passerId === humanPlayerId
      ? ["决定传球目标", "点击高亮的队友；若组合含足球，也可以点击高亮球门。"]
      : ["AI 决定传球目标", "AI 会比较推进收益、射门机会与路线拦截风险。"];
    if (game.phase === "intercept" && game.pass?.blockerId)
      return game.pass.blockerId === humanPlayerId
        ? [`${playerById(game, game.pass.blockerId).label} · 你选择截获牌`, "整组牌已经揭开。选一张加入手牌，其余返回传球者。"]
        : [`${playerById(game, game.pass.blockerId).label} · AI 截获`, "AI 正在权衡球权与行动牌组合。"];
    if (game.phase === "discard" && game.discardQueue[0]) {
      const player = playerById(game, game.discardQueue[0]);
      return player.id === humanPlayerId
        ? [`${player.label} · 你的手牌超限`, `点击行动牌弃置，直到不超过 ${handLimit(game, player)} 张；足球不能弃置。`]
        : [`${player.label} · AI 整理手牌`, `AI 会优先弃置重复属性，同时保留路线多样性。`];
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
          <div className="score-divider"><span>FIRST TO {GAME_BALANCE.winningScore}</span><b>:</b></div>
          <div className="team-score blue-score"><strong>{game.scores.blue}</strong><span>BLUE</span></div>
        </section>

        <div className="header-actions">
          <span className={`possession ${game.offense}`}>{describeTeam(game.offense)}进攻</span>
          <button className="quiet-button" onClick={() => { setGame(createGame()); clearSelections(); setSetupPlayerId(humanPlayerId); }}>
            重开比赛
          </button>
        </div>
      </header>

      <nav className="turn-ribbon" aria-label="回合顺序">
        <span className="turn-label">TURN ORDER</span>
        {TURN_ORDER.map((id, index) => {
          const player = playerById(game, id);
          return (
            <div key={id} className={`turn-chip ${player.team} ${player.id === humanPlayerId ? "human" : "ai"} ${index === game.turnIndex ? "active" : ""}`}>
              <i>{index + 1}</i>{player.label}{hasBall(player) && <b title="持有足球">●</b>}
              <small>{player.id === humanPlayerId ? "YOU" : "AI"}</small>
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
                  current.id === humanPlayerId &&
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

          {aiThinking && actorId && (
            <section className="ai-thinking-panel" aria-live="polite">
              <span className="ai-pulse" />
              <div><strong>{playerById(game, actorId).label} 正在思考</strong><small>收益越高，被选中的概率越大，但仍保留随机性。</small></div>
            </section>
          )}

          {game.aiNote && <p className="ai-note"><strong>最近一次 AI 判断</strong>{game.aiNote}</p>}

          {(game.phase === "setup" || game.phase === "kickoff") && (
            <section className="action-card-panel">
              <div className="panel-title-row"><h3>人机配置</h3><span>1 HUMAN · 5 AI</span></div>
              {game.phase === "setup" && (
                <>
                  <p className="action-hint">选择本局由你控制的球员。开赛后不能更换。</p>
                  <p className="ai-method-note">AI 不是固定脚本：收益越高，被选中的概率越大，但每次仍可能做出不同选择。</p>
                  <div className="human-player-picker">
                    {game.players.map((player) => (
                      <button
                        key={player.id}
                        className={`${player.team} ${player.id === humanPlayerId ? "selected" : ""}`}
                        onClick={() => chooseHumanPlayer(player.id)}
                      >
                        {player.label}<small>{player.team === "red" ? "红队" : "蓝队"}</small>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <p className="action-hint">你只能调整 {playerById(game, humanPlayerId).label}；AI 使用默认阵型。</p>
              <div className="formation-list">
                {game.players.map((player) => (
                  <button
                    key={player.id}
                    disabled={player.id !== humanPlayerId}
                    className={`${player.team} ${player.id === humanPlayerId ? "selected human" : "ai"}`}
                    onClick={() => player.id === humanPlayerId && setSetupPlayerId(player.id)}
                  >
                    {player.label}<small>{player.id === humanPlayerId ? `YOU · ${squareName(player.position)}` : `AI · ${squareName(player.position)}`}</small>
                  </button>
                ))}
              </div>
              <div className="action-row">
                <button className="secondary-action" onClick={resetPositions}>默认阵型</button>
                <button className="primary-action" onClick={startKickoff}>{game.phase === "setup" ? "开始比赛" : "确认开球"}</button>
              </div>
            </section>
          )}

          {humanTurn && (
            <section className="action-card-panel">
              <div className="panel-title-row"><h3>选择行动</h3><span>{current.team === game.offense ? "进攻方" : "防守方"}</span></div>
              <button className="draw-action" onClick={drawCardsForTurn}>
                <span>抽牌</span><strong>+{current.team === game.offense ? GAME_BALANCE.draw.offense : GAME_BALANCE.draw.defense}</strong><small>立即结束回合</small>
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

          {game.phase === "pass-response" && responderId === humanPlayerId && (
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

          {game.phase === "intercept" && game.pass?.blockerId === humanPlayerId && (
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

          {game.phase === "discard" && game.discardQueue[0] === humanPlayerId && (
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
              <button onClick={() => { setGame(createGame()); clearSelections(); setSetupPlayerId(humanPlayerId); }}>再来一局</button>
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
          <div>
            <strong>{focusIsHuman ? "你的手牌" : "AI 手牌"}</strong>
            <small>{focusIsHuman ? "只有你的牌可以操作" : "牌面隐藏 · 仅显示数量"}</small>
          </div>
          <b>{focusPlayer.hand.length} / {handLimit(game, focusPlayer)}</b>
        </div>
        <div className="card-fan">
          {!focusIsHuman && focusPlayer.hand.map((card, index) => (
            <span key={`${card.id}-${index}`} className="play-card hidden-card" aria-label="AI 暗牌">
              <span className="card-corner">PASS AI</span>
              <strong>?</strong>
              <h4>HIDDEN</h4>
              <small>AI CARD</small>
            </span>
          ))}
          {focusIsHuman && focusPlayer.hand.map((card) => {
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
