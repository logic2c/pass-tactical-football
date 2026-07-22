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
  movementPath,
  movementTargets,
  passBlockedByOpponent,
  passPath,
} from "./game-rules";

type Team = "red" | "blue";
type Suit = "rock" | "bishop" | "knight";
type SpecialKind = "tackle";
type Phase = "setup" | "turn" | "discard" | "kickoff" | "gameover";
type ActionMode = "move" | "pass" | "tackle" | null;

type ActionCard = { id: string; kind: "action"; suit: Suit };
type SpecialCard = { id: string; kind: "special"; special: SpecialKind };
type BallCard = { id: "football"; kind: "ball" };
type PlayCard = ActionCard | SpecialCard;
type GameCard = PlayCard | BallCard;

type Player = {
  id: string;
  label: string;
  team: Team;
  position: number;
  hand: GameCard[];
};

type TurnState = {
  cardsPlayed: number;
  tackleUsed: boolean;
  startedWithBall: boolean;
  acquiredBall: boolean;
};

type GameState = {
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
};

const TURN_ORDER = ["r1", "b1", "b2", "r2", "r3", "b3"];
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

const SUIT_INFO: Record<Suit, { name: string; icon: string; caption: string }> = {
  rock: { name: "ROCK", icon: "+", caption: "横纵" },
  bishop: { name: "BISHOP", icon: "×", caption: "斜线" },
  knight: { name: "KNIGHT", icon: "L", caption: "走日" },
};

// 新特殊卡只需在类型、资料和对应效果中注册，不与行动卡规则耦合。
const SPECIAL_INFO: Record<SpecialKind, { name: string; icon: string; caption: string }> = {
  tackle: { name: "TACKLE", icon: "!", caption: "随机抢断" },
};

const FORMATION: Record<string, number> = {
  r1: 51,
  r2: 53,
  r3: 44,
  b1: 11,
  b2: 13,
  b3: 20,
};

const GAME_BALANCE = {
  actionCardsPerSuit: 20,
  specialCards: { tackle: 6 },
  startingHand: 3,
  turnDraw: 2,
  skipPlayDraw: 2,
  handLimit: { offense: 5, defense: 6 },
  winningScore: 3,
  maxTacklesPerTurn: 1,
  maxCardsBeforePassForHolder: 1,
} as const;

const AI_TUNING = {
  turnTemperature: 2.05,
  detailTemperature: 1.55,
  discardTemperature: 1.4,
  thinkDelay: { turn: 620, phase: 420 },
} as const;

function shuffle<T>(items: T[]) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function buildDeck(): PlayCard[] {
  const actions: ActionCard[] = (["rock", "bishop", "knight"] as Suit[]).flatMap((suit) =>
    Array.from({ length: GAME_BALANCE.actionCardsPerSuit }, (_, index) => ({
      id: `${suit}-${index + 1}`,
      kind: "action" as const,
      suit,
    })),
  );
  const specials: SpecialCard[] = Array.from(
    { length: GAME_BALANCE.specialCards.tackle },
    (_, index) => ({ id: `tackle-${index + 1}`, kind: "special", special: "tackle" }),
  );
  return shuffle([...actions, ...specials]);
}

function emptyTurn(): TurnState {
  return { cardsPlayed: 0, tackleUsed: false, startedWithBall: false, acquiredBall: false };
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
    turn: emptyTurn(),
    phase: "setup",
    discardQueue: [],
    log: ["选择你控制的球员并布阵，然后由 R1 开球。"],
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

function actionCards(player: Player) {
  return player.hand.filter((card): card is ActionCard => card.kind === "action");
}

function specialCards(player: Player, kind?: SpecialKind) {
  return player.hand.filter(
    (card): card is SpecialCard => card.kind === "special" && (!kind || card.special === kind),
  );
}

function playableCards(player: Player) {
  return player.hand.filter((card): card is PlayCard => card.kind !== "ball");
}

function otherTeam(team: Team): Team {
  return team === "red" ? "blue" : "red";
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
  game.log = game.log.slice(0, 32);
}

function describePlayCard(card: PlayCard) {
  return card.kind === "action" ? SUIT_INFO[card.suit].name : SPECIAL_INFO[card.special].name;
}

function drawInto(game: GameState, player: Player, count: number) {
  for (let index = 0; index < count; index += 1) {
    if (game.deck.length === 0 && game.discard.length > 0) {
      game.deck = shuffle(game.discard);
      game.discard = [];
      addLog(game, "弃牌堆已重新洗成牌库。");
    }
    const card = game.deck.pop();
    if (!card) break;
    player.hand.push(card);
  }
}

function enterCurrentTurn(game: GameState) {
  const player = activePlayer(game);
  game.phase = "turn";
  game.discardQueue = [];
  game.discardResume = undefined;
  game.turn = {
    cardsPlayed: 0,
    tackleUsed: false,
    startedWithBall: hasBall(player),
    acquiredBall: false,
  };
  drawInto(game, player, GAME_BALANCE.turnDraw);
  addLog(game, `${player.label} 进入抽卡阶段，抽取 ${GAME_BALANCE.turnDraw} 张牌。`);
}

function nextTurn(game: GameState) {
  game.turnIndex = (game.turnIndex + 1) % TURN_ORDER.length;
  enterCurrentTurn(game);
}

function finishPlayPhase(game: GameState) {
  const player = activePlayer(game);
  if (player.hand.length > handLimit(game, player)) {
    game.phase = "discard";
    game.discardQueue = [player.id];
    game.discardResume = "next-turn";
    addLog(game, `${player.label} 进入弃牌阶段，需要将手牌弃至上限。`);
  } else {
    addLog(game, `${player.label} 完成弃牌阶段。`);
    nextTurn(game);
  }
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
    const index = player.hand.findIndex((card) => card.kind === "ball");
    if (index >= 0) ball = player.hand.splice(index, 1)[0] as BallCard;
  });
  game.looseBall = undefined;
  playerById(game, recipientId).hand.push(ball ?? { id: "football", kind: "ball" });
}

function kickoff(game: GameState, receiverId: string, reason: string, endingPlayerId?: string) {
  moveBallTo(game, receiverId);
  game.offense = playerById(game, receiverId).team;
  game.turnIndex = TURN_ORDER.indexOf(receiverId);
  game.kickoffReason = reason;
  game.discardQueue = [];
  game.discardResume = undefined;
  resetFormation(game);
  addLog(game, `${reason} ${playerById(game, receiverId).label} 获得球权，双方重新布阵。`);

  const endingPlayer = endingPlayerId ? playerById(game, endingPlayerId) : undefined;
  if (endingPlayer && endingPlayer.hand.length > handLimit(game, endingPlayer)) {
    game.phase = "discard";
    game.discardQueue = [endingPlayer.id];
    game.discardResume = "kickoff";
  } else {
    game.phase = "kickoff";
  }
}

function scoreGoal(game: GameState, scorer: Player, method: "移动" | "传球") {
  game.scores[scorer.team] += 1;
  addLog(game, `${scorer.label} 通过${method}将足球送入 ${squareName(enemyGoal(scorer.team))}！${describeTeam(scorer.team)}得分。`);
  if (game.scores[scorer.team] >= GAME_BALANCE.winningScore) {
    game.phase = "gameover";
    game.winner = scorer.team;
    return;
  }
  const receiverId = nextOpponent(game, scorer.id, otherTeam(scorer.team));
  kickoff(game, receiverId, "进球后开球：", scorer.id);
}

function isOwnHalf(player: Player, position: number) {
  const row = Math.floor(position / 8);
  return player.team === "red" ? row >= 4 : row <= 3;
}

function canPlayBeforePass(game: GameState, player: Player) {
  if (!hasBall(player)) return true;
  if (game.turn.acquiredBall) return false;
  if (!game.turn.startedWithBall) return false;
  return game.turn.cardsPlayed < GAME_BALANCE.maxCardsBeforePassForHolder;
}

function legalPassTargets(game: GameState, passer: Player, suit: Suit) {
  const occupied = new Set(game.players.map((player) => player.position));
  const targets = new Set<number>();
  for (let position = 0; position < 64; position += 1) {
    if (position === passer.position || occupied.has(position)) continue;
    if (isGoal(position) && position !== enemyGoal(passer.team)) continue;
    const path = passPath(passer.position, position, suit);
    if (!path) continue;
    const blocked = passBlockedByOpponent(passer.position, position, suit, passer.team, game.players);
    if (!blocked) targets.add(position);
  }
  return targets;
}

function resolveMoveAction(game: GameState, cardId: string, position: number) {
  const player = activePlayer(game);
  if (!canPlayBeforePass(game, player)) return false;
  const cardIndex = player.hand.findIndex((card) => card.id === cardId && card.kind === "action");
  if (cardIndex < 0 || !movementTargets(game, player, (player.hand[cardIndex] as ActionCard).suit).has(position)) return false;
  const [card] = player.hand.splice(cardIndex, 1) as ActionCard[];
  const from = player.position;
  const path = movementPath(from, position, card.suit) ?? [position];
  game.discard.push(card);
  game.turn.cardsPlayed += 1;
  player.position = position;
  addLog(game, `${player.label} 使用 ${SUIT_INFO[card.suit].name} 从 ${squareName(from)} 移动到 ${squareName(position)}。`);

  if (game.looseBall !== undefined && path.includes(game.looseBall)) {
    const ballSquare = game.looseBall;
    game.looseBall = undefined;
    player.hand.push({ id: "football", kind: "ball" });
    game.offense = player.team;
    game.turn.acquiredBall = true;
    addLog(game, `${player.label} 在移动途中经过 ${squareName(ballSquare)}，获得足球。`);
  }
  if (position === enemyGoal(player.team) && hasBall(player)) scoreGoal(game, player, "移动");
  return true;
}

function resolveTackleAction(game: GameState, cardId: string, targetId: string) {
  const player = activePlayer(game);
  if (
    !canPlayBeforePass(game, player) ||
    player.team === game.offense ||
    game.turn.tackleUsed ||
    GAME_BALANCE.maxTacklesPerTurn < 1
  ) return false;
  const cardIndex = player.hand.findIndex(
    (card) => card.id === cardId && card.kind === "special" && card.special === "tackle",
  );
  const target = game.players.find((item) => item.id === targetId);
  if (cardIndex < 0 || !target || target.team === player.team || target.hand.length === 0) return false;
  const [card] = player.hand.splice(cardIndex, 1) as SpecialCard[];
  game.discard.push(card);
  game.turn.cardsPlayed += 1;
  game.turn.tackleUsed = true;
  const takenIndex = Math.floor(Math.random() * target.hand.length);
  const [taken] = target.hand.splice(takenIndex, 1);
  player.hand.push(taken);
  if (taken.kind === "ball") {
    game.offense = player.team;
    game.turn.acquiredBall = true;
    addLog(game, `${player.label} 使用抢断卡抽中 ${target.label} 的足球！${describeTeam(player.team)}转为进攻。`);
  } else {
    addLog(game, `${player.label} 使用抢断卡，从 ${target.label} 手牌中抽到 ${describePlayCard(taken)}。`);
  }
  return true;
}

function resolvePassAction(game: GameState, cardId: string, position: number) {
  const passer = activePlayer(game);
  if (!hasBall(passer)) return false;
  const cardIndex = passer.hand.findIndex((card) => card.id === cardId && card.kind === "action");
  if (cardIndex < 0) return false;
  const card = passer.hand[cardIndex] as ActionCard;
  if (!legalPassTargets(game, passer, card.suit).has(position)) return false;
  const [used] = passer.hand.splice(cardIndex, 1) as ActionCard[];
  const ballIndex = passer.hand.findIndex((item) => item.kind === "ball");
  if (ballIndex < 0) return false;
  passer.hand.splice(ballIndex, 1);
  game.discard.push(used);
  game.turn.cardsPlayed += 1;
  if (position === enemyGoal(passer.team)) {
    scoreGoal(game, passer, "传球");
    return true;
  }
  game.looseBall = position;
  addLog(game, `${passer.label} 使用 ${SUIT_INFO[used.suit].name} 将足球传到 ${squareName(position)}；足球现在无人持有。`);
  finishPlayPhase(game);
  return true;
}

function discardOverflowAction(game: GameState, cardId: string) {
  const playerId = game.discardQueue[0];
  if (!playerId) return false;
  const player = playerById(game, playerId);
  const index = player.hand.findIndex((card) => card.id === cardId && card.kind !== "ball");
  if (index < 0) return false;
  const [card] = player.hand.splice(index, 1) as PlayCard[];
  game.discard.push(card);
  addLog(game, `${player.label} 弃掉一张 ${describePlayCard(card)}。`);
  if (player.hand.length <= handLimit(game, player)) game.discardQueue.shift();
  if (game.discardQueue.length === 0) {
    if (game.discardResume === "kickoff") {
      game.phase = "kickoff";
      game.discardResume = undefined;
    } else {
      nextTurn(game);
    }
  }
  return true;
}

function cardPreservationPenalty(player: Player, card: ActionCard) {
  const sameSuit = actionCards(player).filter((item) => item.suit === card.suit).length;
  return sameSuit <= 1 ? 1.1 : sameSuit === 2 ? 0.45 : 0.1;
}

function scoreMove(game: GameState, player: Player, position: number, card: ActionCard) {
  const holder = game.players.find(hasBall);
  const enemies = game.players.filter((item) => item.team !== player.team).map((item) => item.position);
  const path = movementPath(player.position, position, card.suit) ?? [];
  const collectsBall = game.looseBall !== undefined && path.includes(game.looseBall);
  if (position === enemyGoal(player.team) && (hasBall(player) || collectsBall)) return 35;
  if (collectsBall) return 16 + progressGain(player.team, player.position, position) * 1.4;
  const preservation = cardPreservationPenalty(player, card);
  if (player.team === game.offense) {
    const progress = progressGain(player.team, player.position, position);
    const safety = Math.min(3, closestDistance(position, enemies));
    const supportsBall = holder && holder.id !== player.id
      ? gridDistance(player.position, holder.position) - gridDistance(position, holder.position)
      : 0;
    return 1.2 + progress * (hasBall(player) ? 1.7 : 0.85) + safety * 0.25 + supportsBall * 0.35 - preservation;
  }
  const ballPosition = holder?.position ?? game.looseBall ?? enemyGoal(otherTeam(player.team));
  const closesBall = gridDistance(player.position, ballPosition) - gridDistance(position, ballPosition);
  const protectsGoal = goalDistance(otherTeam(player.team), player.position) - goalDistance(otherTeam(player.team), position);
  return 1 + closesBall * 1.35 + protectsGoal * 0.35 - preservation;
}

function scorePassTarget(game: GameState, passer: Player, position: number, card: ActionCard) {
  if (position === enemyGoal(passer.team)) return 38 - cardPreservationPenalty(passer, card);
  const teammates = game.players.filter((player) => player.team === passer.team && player.id !== passer.id);
  const opponents = game.players.filter((player) => player.team !== passer.team);
  const ownDistance = Math.min(...teammates.map((player) => gridDistance(player.position, position)));
  const enemyDistance = Math.min(...opponents.map((player) => gridDistance(player.position, position)));
  const progress = progressGain(passer.team, passer.position, position);
  return 5 + progress * 1.45 + (enemyDistance - ownDistance) * 1.25 - cardPreservationPenalty(passer, card);
}

type AiTurnPlan =
  | { kind: "skip-draw" }
  | { kind: "end" }
  | { kind: "move"; cardId: string; position: number }
  | { kind: "tackle"; cardId: string; targetId: string }
  | { kind: "pass"; cardId: string; position: number };

function logAiSelection<T>(game: GameState, player: Player, selection: AiSelection<T>, label: string) {
  const probability = Math.max(1, Math.round(selection.probability * 100));
  const note = `${player.label} · ${label}：${selection.reason}（本次权重 ${probability}%）`;
  game.aiNote = note;
  addLog(game, `AI 判断：${note}`);
}

function runAiTurn(game: GameState) {
  const player = activePlayer(game);
  const actions = actionCards(player);
  const choices: AiCandidate<AiTurnPlan>[] = [];
  const mustStopOrPass = hasBall(player) && !canPlayBeforePass(game, player);
  const hasPass = hasBall(player) && actions.some((card) => legalPassTargets(game, player, card.suit).size > 0);
  choices.push({
    value: { kind: "end" },
    score: mustStopOrPass && !hasPass ? 9 : game.turn.cardsPlayed >= 2 ? 4.8 : hasBall(player) && hasPass ? -1 : 1.3,
    reason: mustStopOrPass ? "已经获得球权，选择保留足球结束回合" : "保留剩余手牌并结束出牌阶段",
  });
  if (game.turn.cardsPlayed === 0) {
    choices.push({
      value: { kind: "skip-draw" },
      score: player.hand.length <= 3 ? 6.2 : player.hand.length < handLimit(game, player) ? 2.6 : -2.5,
      reason: "跳过出牌阶段，再补充两张牌",
    });
  }

  if (canPlayBeforePass(game, player)) {
    const movePlans: AiCandidate<AiTurnPlan>[] = [];
    actions.forEach((card) => {
      movementTargets(game, player, card.suit).forEach((position) => {
        movePlans.push({
          value: { kind: "move", cardId: card.id, position },
          score: scoreMove(game, player, position, card),
          reason: game.looseBall !== undefined && (movementPath(player.position, position, card.suit) ?? []).includes(game.looseBall)
            ? `移动经过 ${squareName(game.looseBall)} 争夺足球`
            : `${player.team === game.offense ? "推进" : "回防"}到 ${squareName(position)}`,
        });
      });
    });
    const moveChoice = weightedAiChoice(movePlans, AI_TUNING.detailTemperature);
    if (moveChoice) choices.push({ value: moveChoice.value, score: moveChoice.score, reason: moveChoice.reason });

    if (player.team !== game.offense && !game.turn.tackleUsed) {
      const tackle = specialCards(player, "tackle")[0];
      if (tackle) {
        const tacklePlans = game.players
          .filter((target) => target.team !== player.team && target.hand.length > 0)
          .map<AiCandidate<AiTurnPlan>>((target) => {
            const chance = hasBall(target) ? 1 / target.hand.length : 0;
            return {
              value: { kind: "tackle", cardId: tackle.id, targetId: target.id },
              score: 2.4 + chance * 14 + (hasBall(target) ? 3.5 : 0),
              reason: hasBall(target)
                ? `尝试从 ${target.label} 手牌中抢到足球，估计概率 ${Math.round(chance * 100)}%`
                : `尝试削弱 ${target.label} 的手牌`,
            };
          });
        const tackleChoice = weightedAiChoice(tacklePlans, AI_TUNING.detailTemperature);
        if (tackleChoice) choices.push({ value: tackleChoice.value, score: tackleChoice.score, reason: tackleChoice.reason });
      }
    }
  }

  if (hasBall(player)) {
    const passPlans: AiCandidate<AiTurnPlan>[] = [];
    actions.forEach((card) => {
      legalPassTargets(game, player, card.suit).forEach((position) => {
        passPlans.push({
          value: { kind: "pass", cardId: card.id, position },
          score: scorePassTarget(game, player, position, card),
          reason: position === enemyGoal(player.team)
            ? "线路无防守者阻挡，直接射门"
            : `把足球送到 ${squareName(position)}，争取下一次移动先拿到球`,
        });
      });
    });
    const passChoice = weightedAiChoice(passPlans, AI_TUNING.detailTemperature);
    if (passChoice) choices.push({ value: passChoice.value, score: passChoice.score, reason: passChoice.reason });
  }

  const selection = weightedAiChoice(choices, AI_TUNING.turnTemperature);
  if (!selection) return finishPlayPhase(game);
  const labels = { "skip-draw": "蓄力抽牌", end: "结束出牌", move: "连续移动", tackle: "使用抢断卡", pass: "落点传球" };
  logAiSelection(game, player, selection, labels[selection.value.kind]);
  const plan = selection.value;
  if (plan.kind === "skip-draw") {
    drawInto(game, player, GAME_BALANCE.skipPlayDraw);
    addLog(game, `${player.label} 跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张牌。`);
    finishPlayPhase(game);
  } else if (plan.kind === "end") {
    finishPlayPhase(game);
  } else if (plan.kind === "move") {
    if (!resolveMoveAction(game, plan.cardId, plan.position)) finishPlayPhase(game);
  } else if (plan.kind === "tackle") {
    if (!resolveTackleAction(game, plan.cardId, plan.targetId)) finishPlayPhase(game);
  } else if (!resolvePassAction(game, plan.cardId, plan.position)) {
    finishPlayPhase(game);
  }
}

function runAiDiscard(game: GameState) {
  const playerId = game.discardQueue[0];
  if (!playerId) return;
  const player = playerById(game, playerId);
  let safety = 16;
  while (player.hand.length > handLimit(game, player) && safety > 0) {
    safety -= 1;
    const actions = actionCards(player);
    const suitCounts = new Map<Suit, number>();
    actions.forEach((card) => suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1));
    const options = playableCards(player).map<AiCandidate<string>>((card) => ({
      value: card.id,
      score: card.kind === "special"
        ? specialCards(player, card.special).length > 1 ? 5 : 0.8
        : (suitCounts.get(card.suit) ?? 1) * 1.4 - cardPreservationPenalty(player, card),
      reason: card.kind === "special" ? "保留至少一张特殊卡" : `整理重复的 ${SUIT_INFO[card.suit].name}`,
    }));
    const choice = weightedAiChoice(options, AI_TUNING.discardTemperature);
    if (!choice) break;
    logAiSelection(game, player, choice, "弃牌阶段");
    discardOverflowAction(game, choice.value);
  }
}

function phaseActorId(game: GameState) {
  if (game.phase === "turn") return activePlayer(game).id;
  if (game.phase === "discard") return game.discardQueue[0];
  return undefined;
}

function runAiStep(game: GameState, humanPlayerId: string) {
  const actorId = phaseActorId(game);
  if (!actorId || actorId === humanPlayerId) return false;
  if (game.phase === "turn") runAiTurn(game);
  else if (game.phase === "discard") runAiDiscard(game);
  else return false;
  return true;
}

export default function Home() {
  const [game, setGame] = useState<GameState>(() => createGame());
  const [humanPlayerId, setHumanPlayerId] = useState("r1");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<ActionMode>(null);
  const [setupPlayerId, setSetupPlayerId] = useState("r1");

  const current = activePlayer(game);
  const focusPlayer = game.phase === "discard" && game.discardQueue[0]
    ? playerById(game, game.discardQueue[0])
    : current;
  const actorId = phaseActorId(game);
  const aiThinking = Boolean(actorId && actorId !== humanPlayerId);
  const humanTurn = game.phase === "turn" && current.id === humanPlayerId;
  const focusIsHuman = focusPlayer.id === humanPlayerId;
  const selectedCard = current.hand.find(
    (card): card is PlayCard => card.id === selectedCardId && card.kind !== "ball",
  );

  const validCells = (() => {
    if (!humanTurn || selectedCard?.kind !== "action") return new Set<number>();
    if (actionMode === "move" && canPlayBeforePass(game, current)) return movementTargets(game, current, selectedCard.suit);
    if (actionMode === "pass" && hasBall(current)) return legalPassTargets(game, current, selectedCard.suit);
    return new Set<number>();
  })();

  useEffect(() => {
    if (!actorId || actorId === humanPlayerId) return;
    const delay = game.phase === "turn" ? AI_TUNING.thinkDelay.turn : AI_TUNING.thinkDelay.phase;
    const timer = window.setTimeout(() => {
      setGame((previous) => {
        const expected = phaseActorId(previous);
        if (!expected || expected === humanPlayerId || expected !== actorId) return previous;
        const next = structuredClone(previous);
        return runAiStep(next, humanPlayerId) ? next : previous;
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [game, actorId, humanPlayerId]);

  function clearSelections() {
    setSelectedCardId(null);
    setActionMode(null);
  }

  function startKickoff() {
    setGame((previous) => {
      const next = structuredClone(previous);
      enterCurrentTurn(next);
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

  function skipPlayAndDraw() {
    if (!humanTurn || game.turn.cardsPlayed !== 0) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const player = activePlayer(next);
      drawInto(next, player, GAME_BALANCE.skipPlayDraw);
      addLog(next, `${player.label} 跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张牌。`);
      finishPlayPhase(next);
      return next;
    });
    clearSelections();
  }

  function endPlayPhase() {
    if (!humanTurn) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      finishPlayPhase(next);
      return next;
    });
    clearSelections();
  }

  function performMove(position: number) {
    if (!humanTurn || selectedCard?.kind !== "action" || !validCells.has(position)) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolveMoveAction(next, selectedCard.id, position) ? next : previous;
    });
    clearSelections();
  }

  function performPass(position: number) {
    if (!humanTurn || selectedCard?.kind !== "action" || !validCells.has(position)) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolvePassAction(next, selectedCard.id, position) ? next : previous;
    });
    clearSelections();
  }

  function performTackle(targetId: string) {
    if (!humanTurn || selectedCard?.kind !== "special" || selectedCard.special !== "tackle") return;
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolveTackleAction(next, selectedCard.id, targetId) ? next : previous;
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
    if (game.phase === "setup" || game.phase === "kickoff") {
      const selected = playerById(game, setupPlayerId);
      if (selected.id !== humanPlayerId || isGoal(position) || !isOwnHalf(selected, position)) return;
      if (game.players.some((player) => player.position === position && player.id !== selected.id)) return;
      setGame((previous) => {
        const next = structuredClone(previous);
        playerById(next, setupPlayerId).position = position;
        return next;
      });
      return;
    }
    if (!humanTurn) return;
    const target = game.players.find((player) => player.position === position);
    if (actionMode === "tackle" && target) performTackle(target.id);
    else if (actionMode === "move") performMove(position);
    else if (actionMode === "pass") performPass(position);
  }

  const phaseCopy = (() => {
    if (game.phase === "setup") return ["选择角色并布阵", "选择你控制的一名球员；其余五名球员由 AI 控制。"];
    if (game.phase === "kickoff") return [game.kickoffReason, "调整你的球员位置后确认开球；开球者随后自动抽两张。"];
    if (game.phase === "turn") {
      const restriction = hasBall(current)
        ? game.turn.acquiredBall
          ? "本回合中途获得足球：现在只能传球或结束回合。"
          : `持球者传球前最多使用 ${GAME_BALANCE.maxCardsBeforePassForHolder} 张其他牌。`
        : "可按任意顺序连续使用行动卡和特殊卡。";
      return current.id === humanPlayerId
        ? [`${current.label} · 出牌阶段`, `已自动抽两张。${restriction}`]
        : [`${current.label} · AI 出牌阶段`, `AI 正在逐张评估移动、特殊卡、落点传球与结束时机。`];
    }
    if (game.phase === "discard" && game.discardQueue[0]) {
      const player = playerById(game, game.discardQueue[0]);
      return player.id === humanPlayerId
        ? [`${player.label} · 弃牌阶段`, `弃置行动卡或特殊卡，直到不超过 ${handLimit(game, player)} 张。`]
        : [`${player.label} · AI 弃牌阶段`, "AI 会保留路线多样性和稀缺特殊卡。"];
    }
    if (game.phase === "gameover" && game.winner) return [`${describeTeam(game.winner)}获胜`, "三球已到，比赛结束。"];
    return ["PASS", "落地球回合制测试版"];
  })();

  return (
    <main className="game-shell">
      <header className="match-header">
        <div className="brand-block"><div className="brand-mark">P</div><div><p className="kicker">TACTICAL FOOTBALL CARD GAME</p><h1>PASS</h1></div></div>
        <section className="scoreboard" aria-label="比分">
          <div className="team-score red-score"><span>RED</span><strong>{game.scores.red}</strong></div>
          <div className="score-divider"><span>FIRST TO {GAME_BALANCE.winningScore}</span><b>:</b></div>
          <div className="team-score blue-score"><strong>{game.scores.blue}</strong><span>BLUE</span></div>
        </section>
        <div className="header-actions">
          <span className={`possession ${game.offense}`}>{game.looseBall === undefined ? `${describeTeam(game.offense)}进攻` : `足球落地 · ${describeTeam(game.offense)}进攻`}</span>
          <button className="quiet-button" onClick={() => { setGame(createGame()); clearSelections(); setSetupPlayerId(humanPlayerId); }}>重开比赛</button>
        </div>
      </header>

      <nav className="turn-ribbon" aria-label="回合顺序">
        <span className="turn-label">TURN ORDER</span>
        {TURN_ORDER.map((id, index) => {
          const player = playerById(game, id);
          return <div key={id} className={`turn-chip ${player.team} ${player.id === humanPlayerId ? "human" : "ai"} ${index === game.turnIndex ? "active" : ""}`}>
            <i>{index + 1}</i>{player.label}{hasBall(player) && <b title="公开持球者">●</b>}<small>{player.id === humanPlayerId ? "YOU" : "AI"}</small>
          </div>;
        })}
        <span className="deck-count">牌库 {game.deck.length}<i />弃牌 {game.discard.length}</span>
      </nav>

      <div className="game-layout">
        <section className="pitch-panel">
          <div className="pitch-frame">
            <div className="pitch" role="grid" aria-label="8乘8足球棋盘">
              <div className="center-circle" aria-hidden="true" /><div className="halfway-line" aria-hidden="true" />
              {Array.from({ length: 64 }, (_, position) => {
                const player = game.players.find((item) => item.position === position);
                const goal = position === RED_GOAL ? "red" : position === BLUE_GOAL ? "blue" : null;
                const valid = validCells.has(position);
                const setupSelected = player?.id === setupPlayerId && (game.phase === "setup" || game.phase === "kickoff");
                const tackleTarget = humanTurn && actionMode === "tackle" && player && player.team !== current.team && player.hand.length > 0;
                return <button
                  key={position}
                  className={`pitch-cell ${(Math.floor(position / 8) + position) % 2 ? "stripe" : ""} ${valid ? "valid" : ""} ${goal ? `goal ${goal}` : ""} ${tackleTarget ? "tackle-target" : ""}`}
                  onClick={() => handleCell(position)}
                  aria-label={`${squareName(position)}${player ? `，${player.label}` : ""}${game.looseBall === position ? "，足球落点" : ""}`}
                  role="gridcell"
                >
                  <span className="coordinate">{squareName(position)}</span>
                  {goal && <span className="goal-net"><i /><i /><i /></span>}
                  {game.looseBall === position && <span className="loose-ball" title="无人持有的足球">●</span>}
                  {player && <span className={`player-token ${player.team} ${setupSelected ? "selected" : ""} ${player.id === current.id ? "current" : ""}`}>
                    <span className="jersey">{player.label.slice(1)}</span><strong>{player.label}</strong><small>{player.hand.length} 手牌</small>
                    {hasBall(player) && <span className="ball" title="公开持球者">●</span>}
                  </span>}
                </button>;
              })}
            </div>
            <div className="file-labels" aria-hidden="true">{FILES.map((file) => <span key={file}>{file}</span>)}</div>
          </div>
          <div className="pitch-legend"><span><i className="legend-dot available" />可选位置</span><span><i className="legend-dot football" />足球位置始终公开</span><span><i className="legend-dot goal" />持球进入或传入球门得分</span></div>
        </section>

        <aside className="control-column">
          <section className="phase-card"><p className="section-label">MATCH DIRECTOR</p><h2>{phaseCopy[0]}</h2><p>{phaseCopy[1]}</p><div className="phase-rule"><span>{game.phase === "turn" ? `已出 ${game.turn.cardsPlayed} 张` : "LIVE"}</span><i /></div></section>
          {aiThinking && actorId && <section className="ai-thinking-panel" aria-live="polite"><span className="ai-pulse" /><div><strong>{playerById(game, actorId).label} 正在思考</strong><small>AI 会逐步行动，高收益选择更常出现但不固定。</small></div></section>}
          {game.aiNote && <p className="ai-note"><strong>最近一次 AI 判断</strong>{game.aiNote}</p>}

          {(game.phase === "setup" || game.phase === "kickoff") && <section className="action-card-panel">
            <div className="panel-title-row"><h3>人机配置</h3><span>1 HUMAN · 5 AI</span></div>
            {game.phase === "setup" && <><p className="action-hint">选择本局由你控制的球员。开赛后不能更换。</p><div className="human-player-picker">{game.players.map((player) => <button key={player.id} className={`${player.team} ${player.id === humanPlayerId ? "selected" : ""}`} onClick={() => chooseHumanPlayer(player.id)}>{player.label}<small>{describeTeam(player.team)}</small></button>)}</div></>}
            <p className="action-hint">你只能调整 {playerById(game, humanPlayerId).label}；AI 使用默认阵型。</p>
            <div className="formation-list">{game.players.map((player) => <button key={player.id} disabled={player.id !== humanPlayerId} className={`${player.team} ${player.id === humanPlayerId ? "selected human" : "ai"}`} onClick={() => player.id === humanPlayerId && setSetupPlayerId(player.id)}>{player.label}<small>{player.id === humanPlayerId ? `YOU · ${squareName(player.position)}` : `AI · ${squareName(player.position)}`}</small></button>)}</div>
            <div className="action-row"><button className="secondary-action" onClick={resetPositions}>默认阵型</button><button className="primary-action" onClick={startKickoff}>{game.phase === "setup" ? "开始比赛" : "确认开球"}</button></div>
          </section>}

          {humanTurn && <section className="action-card-panel">
            <div className="panel-title-row"><h3>出牌阶段</h3><span>{current.team === game.offense ? "进攻方" : "防守方"}</span></div>
            <button className="draw-action" disabled={game.turn.cardsPlayed !== 0} onClick={skipPlayAndDraw}><span>蓄力</span><strong>+{GAME_BALANCE.skipPlayDraw}</strong><small>跳过整个出牌阶段</small></button>
            <div className="action-row"><button className="secondary-action" onClick={endPlayPhase}>结束出牌</button></div>
            {selectedCard?.kind === "action" && <div className="mode-grid">
              <button disabled={!canPlayBeforePass(game, current)} className={actionMode === "move" ? "active" : ""} onClick={() => setActionMode("move")}>MOVE<small>连续移动</small></button>
              {hasBall(current) && <button className={actionMode === "pass" ? "active" : ""} onClick={() => setActionMode("pass")}>PASS<small>选择空格后结束出牌</small></button>}
            </div>}
            {selectedCard?.kind === "special" && <div className="mode-grid"><button disabled={!canPlayBeforePass(game, current) || current.team === game.offense || game.turn.tackleUsed} className={actionMode === "tackle" ? "active" : ""} onClick={() => setActionMode("tackle")}>TACKLE<small>每回合最多一次</small></button></div>}
            {actionMode === "move" && <p className="action-hint">点击高亮位置。移动路径经过落地足球时会立即获得足球。</p>}
            {actionMode === "pass" && <p className="action-hint">点击高亮空格传球；有对方球员挡在线路中间的格子不可选择。</p>}
            {actionMode === "tackle" && <p className="action-hint">点击任意有手牌的对方球员，随机抽取一张未知牌。</p>}
          </section>}

          {game.phase === "discard" && game.discardQueue[0] === humanPlayerId && <section className="action-card-panel"><div className="panel-title-row"><h3>弃牌阶段</h3><span>{focusPlayer.hand.length} / {handLimit(game, focusPlayer)}</span></div><div className="revealed-hand compact">{focusPlayer.hand.map((card) => <button key={card.id} className={card.kind} disabled={card.kind === "ball"} onClick={() => discardOverflow(card.id)}><strong>{card.kind === "ball" ? "●" : card.kind === "action" ? SUIT_INFO[card.suit].icon : SPECIAL_INFO[card.special].icon}</strong><span>{card.kind === "ball" ? "FOOTBALL" : card.kind === "action" ? SUIT_INFO[card.suit].name : SPECIAL_INFO[card.special].name}</span></button>)}</div></section>}

          {game.phase === "gameover" && <section className={`winner-card ${game.winner}`}><span>FULL TIME</span><strong>{game.scores.red} — {game.scores.blue}</strong><button onClick={() => { setGame(createGame()); clearSelections(); setSetupPlayerId(humanPlayerId); }}>再来一局</button></section>}
          <section className="match-log"><div className="panel-title-row"><h3>比赛记录</h3><span>最新在前</span></div><div className="log-scroll">{game.log.map((message, index) => <p key={`${message}-${index}`}><i>{String(game.log.length - index).padStart(2, "0")}</i>{message}</p>)}</div></section>
        </aside>
      </div>

      <section className="hand-dock" aria-label={`${focusPlayer.label} 手牌`}>
        <div className="hand-owner"><span className={`owner-badge ${focusPlayer.team}`}>{focusPlayer.label}</span><div><strong>{focusIsHuman ? "你的手牌" : "AI 手牌"}</strong><small>{focusIsHuman ? "行动卡负责移动/传球，特殊卡拥有独立效果" : "牌面隐藏 · 持球者仍公开"}</small></div><b>{focusPlayer.hand.length} / {handLimit(game, focusPlayer)}</b></div>
        <div className="card-fan">
          {!focusIsHuman && focusPlayer.hand.map((card, index) => <span key={`${card.id}-${index}`} className="play-card hidden-card" aria-label="AI 暗牌"><span className="card-corner">PASS AI</span><strong>?</strong><h4>HIDDEN</h4><small>UNKNOWN CARD</small></span>)}
          {focusIsHuman && focusPlayer.hand.map((card) => {
            const active = game.phase === "turn" && focusPlayer.id === current.id;
            const selected = active && selectedCardId === card.id;
            const info = card.kind === "ball" ? { name: "BALL", icon: "●", caption: "FOOTBALL" } : card.kind === "action" ? SUIT_INFO[card.suit] : SPECIAL_INFO[card.special];
            return <button key={card.id} className={`play-card ${card.kind} ${selected ? "selected" : ""}`} disabled={!active || card.kind === "ball"} onClick={() => { if (card.kind === "ball") return; setSelectedCardId(selected ? null : card.id); setActionMode(null); }}><span className="card-corner">{info.name}</span><strong>{info.icon}</strong><h4>{info.caption}</h4><small>{card.kind === "ball" ? "具体位置仅持有者可见" : card.kind === "action" ? "MOVE · PASS" : "SPECIAL · 独立效果"}</small></button>;
          })}
        </div>
      </section>
    </main>
  );
}
