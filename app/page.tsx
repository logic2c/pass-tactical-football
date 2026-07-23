"use client";

import { useEffect, useState, type CSSProperties } from "react";
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
  passBlockerCount,
  passBlockedByPlayer,
  passPath,
} from "./game-rules";

type Team = "red" | "blue";
type Suit = "rock" | "bishop" | "knight";
type SpecialKind = "tackle" | "sprint" | "supply" | "long-pass" | "save" | "flying-kick";
type Phase = "setup" | "turn" | "save-response" | "discard" | "kickoff" | "gameover";
type ActionMode = "move" | "pass" | "tackle" | "press" | "flying-kick" | null;
type VisualEventKind = "move" | "pass" | "press" | "tackle" | "sprint" | "supply" | "long-pass" | "save" | "flying-kick" | "offside" | "skip-draw" | "end" | "discard" | "goal" | "kickoff";
type VisualEvent = {
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

type ActionCard = { id: string; kind: "action"; suit: Suit; cost: number };
type SpecialCard = { id: string; kind: "special"; special: SpecialKind; cost: number };
type BallCard = { id: "football"; kind: "ball" };
type PlayCard = ActionCard | SpecialCard;
type GameCard = PlayCard | BallCard;

type Player = {
  id: string;
  label: string;
  team: Team;
  position: number;
  hand: GameCard[];
  nextTurnPenalty: number;
};

type ActionTrace = {
  id: number;
  actorId: string;
  team: Team;
  kind: "move" | "pass" | "response";
  from: number;
  to: number;
  path?: number[];
};

type PendingPass = {
  passerId: string;
  from: number;
  to: number;
  suit: Suit;
  path: number[];
  longPass: boolean;
  responderId?: string;
};

type TurnState = {
  actionsRemaining: number;
  actionsSpent: number;
  tackleUsed: boolean;
  pressUsed: boolean;
  acquiredBall: boolean;
  cardsPlayed: number;
  longPassReady: boolean;
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
  eventSeq: number;
  lastEvent?: VisualEvent;
  traceSeq: number;
  traces: ActionTrace[];
  pendingPass?: PendingPass;
};

const TURN_ORDER = ["r1", "b1", "r2", "b2", "r3", "b3"];
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

const SUIT_INFO: Record<Suit, { name: string; icon: string; caption: string }> = {
  rock: { name: "ROCK", icon: "+", caption: "横纵" },
  bishop: { name: "BISHOP", icon: "×", caption: "斜线" },
  knight: { name: "KNIGHT", icon: "L", caption: "走日" },
};

// 新特殊卡只需在类型、资料和对应效果中注册，不与行动卡规则耦合。
const SPECIAL_INFO: Record<SpecialKind, { name: string; icon: string; caption: string; description: string }> = {
  tackle: { name: "TACKLE", icon: "!", caption: "随机抢断", description: "一格内随机抢走1张牌" },
  sprint: { name: "SPRINT", icon: "+1", caption: "冲刺", description: "本回合获得1点行动力" },
  supply: { name: "SUPPLY", icon: "2", caption: "补给", description: "抽取2张牌" },
  "long-pass": { name: "LONG PASS", icon: "↗", caption: "长传", description: "下一次Pass可越过1人" },
  save: { name: "SAVE", icon: "◆", caption: "扑救", description: "响应Pass并弃牌移动" },
  "flying-kick": { name: "FLYING KICK", icon: "−1", caption: "飞踢", description: "一步内压制并夺球" },
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
  actionCardsPerSuit: 13,
  specialCards: { tackle: 2, sprint: 2, supply: 2, "long-pass": 3, save: 3, "flying-kick": 1 },
  startingHand: 3,
  turnDraw: 1,
  skipPlayDraw: 2,
  handLimit: { offense: 5, defense: 6 },
  winningScore: 3,
  maxTacklesPerTurn: 1,
  maxPressesPerTurn: 1,
  actionPoints: { holder: 1, other: 2 },
} as const;

const AI_TUNING = {
  turnTemperature: 2.05,
  detailTemperature: 1.55,
  discardTemperature: 1.4,
  thinkDelay: { turn: 980, phase: 480 },
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
      cost: 1,
    })),
  );
  const costs: Record<SpecialKind, number> = { tackle: 1, sprint: 0, supply: 1, "long-pass": 0, save: 0, "flying-kick": 1 };
  const specials: SpecialCard[] = (Object.entries(GAME_BALANCE.specialCards) as Array<[SpecialKind, number]>).flatMap(
    ([special, count]) => Array.from({ length: count }, (_, index) => ({
      id: `${special}-${index + 1}`,
      kind: "special" as const,
      special,
      cost: costs[special],
    })),
  );
  return shuffle([...actions, ...specials]);
}

function emptyTurn(): TurnState {
  return { actionsRemaining: 0, actionsSpent: 0, tackleUsed: false, pressUsed: false, acquiredBall: false, cardsPlayed: 0, longPassReady: false };
}

function createGame(): GameState {
  const game: GameState = {
    players: TURN_ORDER.map((id) => ({
      id,
      label: id.toUpperCase(),
      team: id.startsWith("r") ? "red" : "blue",
      position: FORMATION[id],
      hand: [],
      nextTurnPenalty: 0,
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
    eventSeq: 0,
    traceSeq: 0,
    traces: [],
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

function countedHandSize(player: Player) {
  return player.hand.filter((card) => card.kind !== "ball").length;
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

function emitEvent(game: GameState, event: Omit<VisualEvent, "id">) {
  game.eventSeq += 1;
  game.lastEvent = { id: game.eventSeq, ...event };
}

function remainingActionCopy(game: GameState) {
  return game.turn.actionsRemaining > 0
    ? `剩余 ${game.turn.actionsRemaining} 点行动力。`
    : "本回合行动力已用完。";
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
  game.pendingPass = undefined;
  game.traces = game.traces.filter((trace) => trace.actorId !== player.id);
  drawInto(game, player, GAME_BALANCE.turnDraw);
  const baseActions = hasBall(player) ? GAME_BALANCE.actionPoints.holder : GAME_BALANCE.actionPoints.other;
  const penalty = player.nextTurnPenalty;
  player.nextTurnPenalty = 0;
  game.turn = {
    actionsRemaining: Math.max(0, baseActions - penalty),
    actionsSpent: 0,
    tackleUsed: false,
    pressUsed: false,
    acquiredBall: false,
    cardsPlayed: 0,
    longPassReady: false,
  };
  addLog(game, `${player.label} 抽取 ${GAME_BALANCE.turnDraw} 张牌，并在准备阶段获得 ${game.turn.actionsRemaining} 点行动力${penalty ? `（飞踢影响 −${penalty}）` : ""}。`);
}

function nextTurn(game: GameState) {
  game.turnIndex = (game.turnIndex + 1) % TURN_ORDER.length;
  enterCurrentTurn(game);
}

function finishPlayPhase(game: GameState) {
  const player = activePlayer(game);
  if (countedHandSize(player) > handLimit(game, player)) {
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
  game.traces = [];
  game.pendingPass = undefined;
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
  if (endingPlayer && countedHandSize(endingPlayer) > handLimit(game, endingPlayer)) {
    game.phase = "discard";
    game.discardQueue = [endingPlayer.id];
    game.discardResume = "kickoff";
  } else {
    game.phase = "kickoff";
  }
}

function scoreGoal(
  game: GameState,
  scorer: Player,
  method: "移动" | "传球",
  origin = scorer.position,
  route: number[] = [enemyGoal(scorer.team)],
) {
  const scorerId = scorer.id;
  const goal = enemyGoal(scorer.team);
  const scoringTeam = scorer.team;
  game.scores[scorer.team] += 1;
  addLog(game, `${scorer.label} 通过${method}将足球送入 ${squareName(goal)}！${describeTeam(scorer.team)}得分。`);
  if (game.scores[scorer.team] >= GAME_BALANCE.winningScore) {
    game.phase = "gameover";
    game.winner = scorer.team;
  } else {
    const receiverId = nextOpponent(game, scorer.id, otherTeam(scorer.team));
    kickoff(game, receiverId, "进球后开球：", scorer.id);
  }
  emitEvent(game, {
    kind: "goal",
    actorId: scorerId,
    from: origin,
    to: goal,
    path: route,
    ballSquare: goal,
    label: `${scorerId.toUpperCase()} ${method}破门`,
    result: `${describeTeam(scoringTeam)}得分，比分 ${game.scores.red} : ${game.scores.blue}。`,
    tone: "goal",
    team: scoringTeam,
  });
}

function isOwnHalf(player: Player, position: number) {
  const row = Math.floor(position / 8);
  return player.team === "red" ? row >= 4 : row <= 3;
}

function canAct(game: GameState) {
  return game.turn.actionsRemaining > 0;
}

function spendAction(game: GameState, cost = 1) {
  if (game.turn.actionsRemaining < cost) return false;
  game.turn.actionsRemaining -= cost;
  game.turn.actionsSpent += cost;
  game.turn.cardsPlayed += 1;
  return true;
}

function recordTrace(game: GameState, trace: Omit<ActionTrace, "id">) {
  game.traceSeq += 1;
  game.traces.push({ id: game.traceSeq, ...trace });
}

function markBallAcquired(game: GameState) {
  game.turn.acquiredBall = true;
}

function isAdjacent(left: number, right: number) {
  const rowDistance = Math.abs(Math.floor(left / 8) - Math.floor(right / 8));
  const colDistance = Math.abs((left % 8) - (right % 8));
  return Math.max(rowDistance, colDistance) === 1;
}

function isStepAdjacent(left: number, right: number) {
  const rowDistance = Math.abs(Math.floor(left / 8) - Math.floor(right / 8));
  const colDistance = Math.abs((left % 8) - (right % 8));
  return rowDistance + colDistance === 1;
}

function exactStepPaths(game: GameState, player: Player, steps: number) {
  const occupied = new Set(game.players.filter((item) => item.id !== player.id).map((item) => item.position));
  let frontier = new Map<number, number[]>([[player.position, []]]);
  for (let step = 0; step < steps; step += 1) {
    const nextFrontier = new Map<number, number[]>();
    frontier.forEach((path, position) => {
      const row = Math.floor(position / 8);
      const col = position % 8;
      [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([rowDelta, colDelta]) => {
        const nextRow = row + rowDelta;
        const nextCol = col + colDelta;
        if (nextRow < 0 || nextRow > 7 || nextCol < 0 || nextCol > 7) return;
        const next = nextRow * 8 + nextCol;
        if (occupied.has(next) || isGoal(next) || nextFrontier.has(next)) return;
        nextFrontier.set(next, [...path, next]);
      });
    });
    frontier = nextFrontier;
  }
  frontier.delete(player.position);
  return frontier;
}

function legalPassTargets(game: GameState, passer: Player, suit: Suit, longPass = false) {
  const targets = new Set<number>();
  for (let position = 0; position < 64; position += 1) {
    if (position === passer.position) continue;
    const occupant = game.players.find((player) => player.position === position);
    if (occupant && occupant.team !== passer.team) continue;
    if (isGoal(position) && position !== enemyGoal(passer.team)) continue;
    if (longPass && position === enemyGoal(passer.team)) continue;
    const path = passPath(passer.position, position, suit);
    if (!path) continue;
    const blocked = longPass
      ? passBlockerCount(passer.position, position, suit, game.players) > 1
      : passBlockedByPlayer(passer.position, position, suit, game.players);
    if (!blocked) targets.add(position);
  }

  // Knight passes cross one orthogonal square first. A teammate on that square
  // stops the route, but may receive the ball directly.
  if (suit === "knight") {
    for (let position = 0; position < 64; position += 1) {
      const path = passPath(passer.position, position, suit);
      if (!path?.length) continue;
      const firstPlayer = game.players.find((player) => player.position === path[0]);
      if (firstPlayer?.team === passer.team && (!longPass || firstPlayer.position !== enemyGoal(passer.team))) targets.add(firstPlayer.position);
    }
  }
  return targets;
}

function passRoute(from: number, to: number, suit: Suit) {
  const path = passPath(from, to, suit) ?? [];
  return [...path, to].filter((cell, index, cells) => cells.indexOf(cell) === index);
}

function hasOffsidePlayer(game: GameState, team: Team) {
  return game.players.some((player) => player.team === team && player.position === enemyGoal(team));
}

function saveExtraCards(player: Player, saveCardId?: string) {
  return player.hand.filter((card): card is PlayCard => card.kind !== "ball" && card.id !== saveCardId);
}

function eligibleSaveResponders(game: GameState, pending: PendingPass) {
  const passer = playerById(game, pending.passerId);
  return game.players.filter((player) => {
    const save = specialCards(player, "save")[0];
    return player.team !== passer.team && isOwnHalf(player, player.position) && Boolean(save) && saveExtraCards(player, save?.id).length > 0;
  });
}

function resolveMoveAction(game: GameState, cardId: string, position: number) {
  const player = activePlayer(game);
  if (!canAct(game)) return false;
  const cardIndex = player.hand.findIndex((card) => card.id === cardId && card.kind === "action");
  if (cardIndex < 0 || !movementTargets(game, player, (player.hand[cardIndex] as ActionCard).suit).has(position)) return false;
  const [card] = player.hand.splice(cardIndex, 1) as ActionCard[];
  const from = player.position;
  const path = movementPath(from, position, card.suit) ?? [position];
  if (!spendAction(game, card.cost)) return false;
  game.discard.push(card);
  player.position = position;
  addLog(game, `${player.label} 使用 ${SUIT_INFO[card.suit].name} 从 ${squareName(from)} 移动到 ${squareName(position)}。`);

  let pickedUpAt: number | undefined;
  if (game.looseBall !== undefined && path.includes(game.looseBall)) {
    const ballSquare = game.looseBall;
    pickedUpAt = ballSquare;
    game.looseBall = undefined;
    player.hand.push({ id: "football", kind: "ball" });
    game.offense = player.team;
    markBallAcquired(game);
    addLog(game, `${player.label} 在移动途中经过 ${squareName(ballSquare)}，获得足球。`);
  }
  if (position === enemyGoal(player.team) && hasBall(player)) {
    scoreGoal(game, player, "移动", from, path);
    return true;
  }
  recordTrace(game, { actorId: player.id, team: player.team, kind: "move", from, to: position });
  emitEvent(game, {
    kind: "move",
    actorId: player.id,
    from,
    to: position,
    path,
    ballSquare: pickedUpAt,
    label: `${player.label} 使用 ${SUIT_INFO[card.suit].name} 移动`,
    result: pickedUpAt === undefined
      ? `${squareName(from)} → ${squareName(position)}。${remainingActionCopy(game)}`
      : `途经 ${squareName(pickedUpAt)} 获得足球。${remainingActionCopy(game)}`,
    tone: pickedUpAt === undefined ? "neutral" : "success",
  });
  return true;
}

function resolveTackleAction(game: GameState, cardId: string, targetId: string) {
  const player = activePlayer(game);
  if (
    !canAct(game) ||
    game.turn.tackleUsed ||
    GAME_BALANCE.maxTacklesPerTurn < 1
  ) return false;
  const cardIndex = player.hand.findIndex(
    (card) => card.id === cardId && card.kind === "special" && card.special === "tackle",
  );
  const target = game.players.find((item) => item.id === targetId);
  if (
    cardIndex < 0 ||
    !target ||
    target.team === player.team ||
    target.hand.length === 0 ||
    !isAdjacent(player.position, target.position)
  ) return false;
  const [card] = player.hand.splice(cardIndex, 1) as SpecialCard[];
  if (!spendAction(game, card.cost)) return false;
  game.discard.push(card);
  game.turn.tackleUsed = true;
  const takenIndex = Math.floor(Math.random() * target.hand.length);
  const [taken] = target.hand.splice(takenIndex, 1);
  player.hand.push(taken);
  if (taken.kind === "ball") {
    game.offense = player.team;
    markBallAcquired(game);
    addLog(game, `${player.label} 使用抢断卡抽中 ${target.label} 的足球！${describeTeam(player.team)}转为进攻。`);
  } else {
    addLog(game, `${player.label} 使用抢断卡，从 ${target.label} 手牌中抢走 1 张未知牌。`);
  }
  emitEvent(game, {
    kind: "tackle",
    actorId: player.id,
    targetId: target.id,
    from: player.position,
    to: target.position,
    path: [target.position],
    label: `${player.label} 对 ${target.label} 使用 TACKLE`,
    result: taken.kind === "ball"
      ? `抢到足球，${describeTeam(player.team)}转为进攻。${remainingActionCopy(game)}`
      : `抢走 1 张未知牌。${remainingActionCopy(game)}`,
    tone: taken.kind === "ball" ? "success" : "neutral",
  });
  return true;
}

function resolvePressAction(game: GameState, targetId: string) {
  const player = activePlayer(game);
  const target = game.players.find((item) => item.id === targetId);
  if (
    !canAct(game) ||
    player.team === game.offense ||
    game.turn.pressUsed ||
    GAME_BALANCE.maxPressesPerTurn < 1 ||
    !target ||
    target.team === player.team ||
    target.hand.length === 0 ||
    !isAdjacent(player.position, target.position)
  ) return false;
  if (!spendAction(game, 1)) return false;
  game.turn.pressUsed = true;
  const takenIndex = Math.floor(Math.random() * target.hand.length);
  const inspected = target.hand[takenIndex];
  if (inspected.kind === "ball") {
    const [ball] = target.hand.splice(takenIndex, 1);
    player.hand.push(ball);
    game.offense = player.team;
    markBallAcquired(game);
    addLog(game, `${player.label} 近身上抢 ${target.label} 并抽中足球！${remainingActionCopy(game)}`);
  } else {
    addLog(game, `${player.label} 近身上抢 ${target.label}，但抽中的牌不是足球，牌已放回。`);
  }
  emitEvent(game, {
    kind: "press",
    actorId: player.id,
    targetId: target.id,
    from: player.position,
    to: target.position,
    path: [target.position],
    label: `${player.label} 对 ${target.label} 发起上抢`,
    result: inspected.kind === "ball"
      ? `抽中足球，${describeTeam(player.team)}转为进攻。${remainingActionCopy(game)}`
      : `抽中非足球牌，已原样放回。${remainingActionCopy(game)}`,
    tone: inspected.kind === "ball" ? "success" : "failure",
  });
  return true;
}

function takeSpecialCard(game: GameState, player: Player, cardId: string, kind: SpecialKind) {
  const index = player.hand.findIndex((card) => card.id === cardId && card.kind === "special" && card.special === kind);
  if (index < 0) return undefined;
  const [card] = player.hand.splice(index, 1) as SpecialCard[];
  game.discard.push(card);
  return card;
}

function resolveSprintAction(game: GameState, cardId: string) {
  const player = activePlayer(game);
  const card = takeSpecialCard(game, player, cardId, "sprint");
  if (!card || !spendAction(game, card.cost)) return false;
  game.turn.actionsRemaining += 1;
  addLog(game, `${player.label} 使用冲刺，本回合额外获得 1 点行动力。`);
  emitEvent(game, { kind: "sprint", actorId: player.id, label: `${player.label} 使用冲刺`, result: `行动力 +1，当前剩余 ${game.turn.actionsRemaining} 点。`, tone: "success" });
  return true;
}

function resolveSupplyAction(game: GameState, cardId: string) {
  const player = activePlayer(game);
  const index = player.hand.findIndex((card) => card.id === cardId && card.kind === "special" && card.special === "supply");
  if (index < 0 || game.turn.actionsRemaining < 1) return false;
  const card = takeSpecialCard(game, player, cardId, "supply")!;
  if (!spendAction(game, card.cost)) return false;
  drawInto(game, player, 2);
  addLog(game, `${player.label} 使用补给并抽取 2 张牌。`);
  emitEvent(game, { kind: "supply", actorId: player.id, label: `${player.label} 使用补给`, result: `抽取 2 张牌。${remainingActionCopy(game)}`, tone: "neutral" });
  return true;
}

function resolveLongPassAction(game: GameState, cardId: string) {
  const player = activePlayer(game);
  if (!hasBall(player) || game.turn.longPassReady || actionCards(player).length === 0) return false;
  const card = takeSpecialCard(game, player, cardId, "long-pass");
  if (!card || !spendAction(game, card.cost)) return false;
  game.turn.longPassReady = true;
  addLog(game, `${player.label} 准备长传：本回合下一次 Pass 可以越过 1 名球员，但不能射门。`);
  emitEvent(game, { kind: "long-pass", actorId: player.id, label: `${player.label} 准备长传`, result: "下一次 Pass 可越过 1 名球员，但不能传入球门。", tone: "success" });
  return true;
}

function resolveSaveRecycle(game: GameState, cardId: string) {
  const player = activePlayer(game);
  if (player.team !== game.offense) return false;
  const card = takeSpecialCard(game, player, cardId, "save");
  if (!card || !spendAction(game, card.cost)) return false;
  drawInto(game, player, 1);
  addLog(game, `${player.label} 作为进攻方弃置扑救并抽取 1 张牌。`);
  emitEvent(game, { kind: "save", actorId: player.id, label: `${player.label} 更换扑救`, result: "不消耗行动力，弃置扑救并抽取 1 张牌。", tone: "neutral" });
  return true;
}

function resolveFlyingKickAction(game: GameState, cardId: string, targetId: string) {
  const player = activePlayer(game);
  const target = game.players.find((item) => item.id === targetId);
  if (!target || target.team === player.team || !isStepAdjacent(player.position, target.position) || game.turn.actionsRemaining < 1) return false;
  const card = takeSpecialCard(game, player, cardId, "flying-kick");
  if (!card || !spendAction(game, card.cost)) return false;
  target.nextTurnPenalty += 1;
  const stoleBall = hasBall(target);
  if (stoleBall) {
    moveBallTo(game, player.id);
    game.offense = player.team;
    markBallAcquired(game);
  }
  addLog(game, `${player.label} 对 ${target.label} 使用飞踢；目标下回合行动力 −1${stoleBall ? "，足球被夺走" : ""}。`);
  emitEvent(game, {
    kind: "flying-kick",
    actorId: player.id,
    targetId: target.id,
    from: player.position,
    to: target.position,
    path: [target.position],
    label: `${player.label} 对 ${target.label} 使用飞踢`,
    result: `目标下回合行动力 −1${stoleBall ? `；${player.label} 获得足球` : ""}。${remainingActionCopy(game)}`,
    tone: stoleBall ? "success" : "neutral",
  });
  return true;
}

function completePendingPass(game: GameState, prefix = "") {
  const pending = game.pendingPass;
  if (!pending) return false;
  const passer = playerById(game, pending.passerId);
  const recipient = game.players.find((player) => player.position === pending.to && player.team === passer.team);
  const ballIndex = passer.hand.findIndex((item) => item.kind === "ball");
  if (ballIndex < 0) return false;
  const [ball] = passer.hand.splice(ballIndex, 1) as BallCard[];
  game.pendingPass = undefined;
  if (pending.to === enemyGoal(passer.team)) {
    scoreGoal(game, passer, "传球", pending.from, pending.path);
    return true;
  }
  if (recipient) {
    recipient.hand.push(ball);
    game.looseBall = undefined;
    addLog(game, `${passer.label} 将足球直接传给 ${recipient.label}。`);
  } else {
    game.looseBall = pending.to;
    addLog(game, `${passer.label} 将足球传到 ${squareName(pending.to)}；足球现在无人持有。`);
  }
  recordTrace(game, { actorId: passer.id, team: passer.team, kind: "pass", from: pending.from, to: pending.to });
  emitEvent(game, {
    kind: "pass",
    actorId: passer.id,
    targetId: recipient?.id,
    from: pending.from,
    to: pending.to,
    path: pending.path,
    ballSquare: pending.to,
    label: `${passer.label} ${pending.longPass ? "完成长传" : "完成传球"}`,
    result: `${prefix}${recipient ? `${recipient.label} 直接接到足球。` : `足球落在 ${squareName(pending.to)}。`}`,
    tone: recipient ? "success" : "neutral",
  });
  finishPlayPhase(game);
  return true;
}

function resolvePassAction(game: GameState, cardId: string, position: number, humanPlayerId?: string) {
  const passer = activePlayer(game);
  if (!hasBall(passer) || !canAct(game)) return false;
  const cardIndex = passer.hand.findIndex((card) => card.id === cardId && card.kind === "action");
  if (cardIndex < 0) return false;
  const card = passer.hand[cardIndex] as ActionCard;
  const longPass = game.turn.longPassReady;
  if (!legalPassTargets(game, passer, card.suit, longPass).has(position)) return false;
  const from = passer.position;
  const path = passRoute(from, position, card.suit);
  const [used] = passer.hand.splice(cardIndex, 1) as ActionCard[];
  if (!spendAction(game, used.cost)) return false;
  game.discard.push(used);
  game.turn.longPassReady = false;

  if (hasOffsidePlayer(game, passer.team)) {
    const receiverId = nextOpponent(game, passer.id, otherTeam(passer.team));
    kickoff(game, receiverId, "越位后交换球权：", passer.id);
    emitEvent(game, {
      kind: "offside",
      actorId: passer.id,
      from,
      to: position,
      label: `${passer.label} 传球越位`,
      result: `${describeTeam(otherTeam(passer.team))}获得球权并重新开球。`,
      tone: "failure",
    });
    return true;
  }

  game.pendingPass = { passerId: passer.id, from, to: position, suit: used.suit, path, longPass };
  const responders = eligibleSaveResponders(game, game.pendingPass);
  const humanResponder = humanPlayerId ? responders.find((player) => player.id === humanPlayerId) : undefined;
  const responder = humanResponder ?? [...responders].sort((left, right) => {
    const leftDistance = Math.min(...path.map((cell) => gridDistance(left.position, cell)));
    const rightDistance = Math.min(...path.map((cell) => gridDistance(right.position, cell)));
    return leftDistance - rightDistance;
  })[0];

  if (!responder) return completePendingPass(game);
  game.pendingPass.responderId = responder.id;
  game.phase = "save-response";
  addLog(game, `${passer.label} 宣布${longPass ? "长传" : "传球"}到 ${squareName(position)}；${responder.label} 可以响应扑救。`);
  emitEvent(game, {
    kind: "pass",
    actorId: passer.id,
    from,
    to: position,
    path,
    ballSquare: position,
    label: `${passer.label} 宣布${longPass ? "长传" : "传球"}`,
    result: `${responder.label} 可以在足球移动前响应扑救。`,
    tone: "neutral",
  });
  return true;
}

function resolveSaveResponse(game: GameState, extraCardIds: string[], destination: number) {
  const pending = game.pendingPass;
  if (!pending?.responderId || extraCardIds.length < 1) return false;
  const responder = playerById(game, pending.responderId);
  const save = specialCards(responder, "save")[0];
  if (!save || !isOwnHalf(responder, responder.position)) return false;
  const uniqueIds = [...new Set(extraCardIds)];
  if (uniqueIds.length !== extraCardIds.length) return false;
  const extras = uniqueIds.map((id) => responder.hand.find((card) => card.id === id && card.kind !== "ball" && card.id !== save.id));
  if (extras.some((card) => !card)) return false;
  const route = exactStepPaths(game, responder, uniqueIds.length).get(destination);
  if (!route) return false;
  const from = responder.position;
  const removeIds = new Set([save.id, ...uniqueIds]);
  const discarded = responder.hand.filter((card): card is PlayCard => card.kind !== "ball" && removeIds.has(card.id));
  responder.hand = responder.hand.filter((card) => !removeIds.has(card.id));
  game.discard.push(...discarded);
  responder.position = destination;
  recordTrace(game, { actorId: responder.id, team: responder.team, kind: "response", from, to: destination, path: route });
  const intercepted = pending.path.includes(destination);
  if (intercepted) {
    moveBallTo(game, responder.id);
    game.offense = responder.team;
    game.pendingPass = undefined;
    addLog(game, `${responder.label} 弃置 ${uniqueIds.length} 张牌完成扑救，在 ${squareName(destination)} 截下足球。`);
    emitEvent(game, {
      kind: "save",
      actorId: responder.id,
      from,
      to: destination,
      path: route,
      ballSquare: destination,
      label: `${responder.label} 扑救成功`,
      result: `移动 ${uniqueIds.length} 步截下足球，${describeTeam(responder.team)}转为进攻。`,
      tone: "success",
    });
    finishPlayPhase(game);
    return true;
  }
  addLog(game, `${responder.label} 扑救移动 ${uniqueIds.length} 步，但未能触及传球线路。`);
  return completePendingPass(game, `${responder.label} 扑救未成功；`);
}

function declineSaveResponse(game: GameState) {
  const responder = game.pendingPass?.responderId ? playerById(game, game.pendingPass.responderId) : undefined;
  return completePendingPass(game, responder ? `${responder.label} 放弃扑救；` : "");
}

function discardOverflowAction(game: GameState, cardId: string) {
  const playerId = game.discardQueue[0];
  if (!playerId) return false;
  const player = playerById(game, playerId);
  const index = player.hand.findIndex((card) => card.id === cardId && card.kind !== "ball");
  if (index < 0) return false;
  const [card] = player.hand.splice(index, 1) as PlayCard[];
  game.discard.push(card);
  addLog(game, `${player.label} 弃掉 1 张牌。`);
  emitEvent(game, {
    kind: "discard",
    actorId: player.id,
    label: `${player.label} 弃置手牌`,
    result: "弃掉 1 张牌。",
    tone: "neutral",
  });
  if (countedHandSize(player) <= handLimit(game, player)) game.discardQueue.shift();
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
  const recipient = game.players.find((player) => player.position === position && player.team === passer.team);
  if (recipient) {
    const progress = progressGain(passer.team, passer.position, recipient.position);
    const opponents = game.players.filter((player) => player.team !== passer.team).map((player) => player.position);
    const safety = Math.min(3, closestDistance(recipient.position, opponents));
    return 10 + progress * 1.5 + safety * 0.6 - cardPreservationPenalty(passer, card);
  }
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
  | { kind: "press"; targetId: string }
  | { kind: "pass"; cardId: string; position: number }
  | { kind: "sprint"; cardId: string }
  | { kind: "supply"; cardId: string }
  | { kind: "long-pass"; cardId: string }
  | { kind: "save-recycle"; cardId: string }
  | { kind: "flying-kick"; cardId: string; targetId: string };

function logAiSelection<T>(game: GameState, player: Player, selection: AiSelection<T>, label: string) {
  const probability = Math.max(1, Math.round(selection.probability * 100));
  const note = `${player.label} · ${label}：${selection.reason}（本次权重 ${probability}%）`;
  game.aiNote = note;
  addLog(game, `AI 判断：${note}`);
}

function runAiTurn(game: GameState, humanPlayerId: string) {
  const player = activePlayer(game);
  const actions = actionCards(player);
  const choices: AiCandidate<AiTurnPlan>[] = [];
  const hasPass = hasBall(player) && actions.some((card) => legalPassTargets(game, player, card.suit, game.turn.longPassReady).size > 0);
  choices.push({
    value: { kind: "end" },
    score: !canAct(game) ? 10 : game.turn.actionsSpent >= 2 ? 5.2 : hasBall(player) && hasPass ? -1 : 1.3,
    reason: !canAct(game) ? "行动点已经用完" : "保留剩余手牌并结束出牌阶段",
  });
  if (game.turn.cardsPlayed === 0) {
    choices.push({
      value: { kind: "skip-draw" },
      score: countedHandSize(player) <= 3 ? 6.2 : countedHandSize(player) < handLimit(game, player) ? 2.6 : -2.5,
      reason: "跳过出牌阶段，再补充两张牌",
    });
  }

  const sprint = specialCards(player, "sprint")[0];
  if (sprint) choices.push({ value: { kind: "sprint", cardId: sprint.id }, score: game.turn.actionsRemaining === 0 ? 8 : hasBall(player) ? 5.4 : 3.4, reason: "用0费冲刺增加本回合行动空间" });

  const longPass = specialCards(player, "long-pass")[0];
  if (longPass && hasBall(player) && !game.turn.longPassReady && actions.length > 0) {
    const bypassTargets = actions.reduce((sum, card) => sum + Math.max(0, legalPassTargets(game, player, card.suit, true).size - legalPassTargets(game, player, card.suit, false).size), 0);
    choices.push({ value: { kind: "long-pass", cardId: longPass.id }, score: bypassTargets > 0 ? 7.2 : 1.1, reason: bypassTargets > 0 ? `发现 ${bypassTargets} 条可越人的传球线路` : "尝试拉开长传线路" });
  }

  const saveToRecycle = specialCards(player, "save")[0];
  if (saveToRecycle && player.team === game.offense) {
    choices.push({ value: { kind: "save-recycle", cardId: saveToRecycle.id }, score: countedHandSize(player) < handLimit(game, player) ? 3.8 : 1.4, reason: "进攻方将暂时无用的扑救换成新牌" });
  }

  if (canAct(game)) {
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

    if (player.team !== game.offense && !game.turn.pressUsed) {
      const pressPlans = game.players
        .filter((target) => target.team !== player.team && target.hand.length > 0 && isAdjacent(player.position, target.position))
        .map<AiCandidate<AiTurnPlan>>((target) => {
          const chance = hasBall(target) ? 1 / target.hand.length : 0;
          return {
            value: { kind: "press", targetId: target.id },
            score: 2.8 + chance * 11 + (hasBall(target) ? 3 : 0),
            reason: hasBall(target)
              ? `近身上抢 ${target.label}，抢到足球的估计概率 ${Math.round(chance * 100)}%`
              : `无卡试探 ${target.label} 的手牌`,
          };
        });
      const pressChoice = weightedAiChoice(pressPlans, AI_TUNING.detailTemperature);
      if (pressChoice) choices.push({ value: pressChoice.value, score: pressChoice.score, reason: pressChoice.reason });
    }

    if (!game.turn.tackleUsed) {
      const tackle = specialCards(player, "tackle")[0];
      if (tackle) {
        const tacklePlans = game.players
          .filter((target) => target.team !== player.team && target.hand.length > 0 && isAdjacent(player.position, target.position))
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

    const supply = specialCards(player, "supply")[0];
    if (supply) choices.push({ value: { kind: "supply", cardId: supply.id }, score: countedHandSize(player) <= 3 ? 5.8 : 2.1, reason: "消耗1点行动力补充两张牌" });

    const flyingKick = specialCards(player, "flying-kick")[0];
    if (flyingKick) {
      const kickPlans = game.players
        .filter((target) => target.team !== player.team && isStepAdjacent(player.position, target.position))
        .map<AiCandidate<AiTurnPlan>>((target) => ({
          value: { kind: "flying-kick", cardId: flyingKick.id, targetId: target.id },
          score: hasBall(target) ? 20 : 5.2,
          reason: hasBall(target) ? `飞踢 ${target.label} 并直接夺取足球` : `压低 ${target.label} 下回合行动力`,
        }));
      const kickChoice = weightedAiChoice(kickPlans, AI_TUNING.detailTemperature);
      if (kickChoice) choices.push({ value: kickChoice.value, score: kickChoice.score, reason: kickChoice.reason });
    }
  }

  if (hasBall(player) && canAct(game)) {
    const passPlans: AiCandidate<AiTurnPlan>[] = [];
    actions.forEach((card) => {
      legalPassTargets(game, player, card.suit, game.turn.longPassReady).forEach((position) => {
        passPlans.push({
          value: { kind: "pass", cardId: card.id, position },
          score: scorePassTarget(game, player, position, card),
          reason: position === enemyGoal(player.team)
            ? "线路无防守者阻挡，直接射门"
            : game.players.some((target) => target.position === position && target.team === player.team)
              ? `直接传给 ${game.players.find((target) => target.position === position)?.label}`
              : `把足球送到 ${squareName(position)}，争取下一次移动先拿到球`,
        });
      });
    });
    const passChoice = weightedAiChoice(passPlans, AI_TUNING.detailTemperature);
    if (passChoice) choices.push({ value: passChoice.value, score: passChoice.score, reason: passChoice.reason });
  }

  const selection = weightedAiChoice(choices, AI_TUNING.turnTemperature);
  if (!selection) return finishPlayPhase(game);
  const labels = { "skip-draw": "蓄力抽牌", end: "结束出牌", move: "移动", tackle: "使用抢断卡", press: "近身上抢", pass: "落点传球", sprint: "冲刺", supply: "补给", "long-pass": "准备长传", "save-recycle": "更换扑救", "flying-kick": "飞踢" };
  logAiSelection(game, player, selection, labels[selection.value.kind]);
  const plan = selection.value;
  if (plan.kind === "skip-draw") {
    drawInto(game, player, GAME_BALANCE.skipPlayDraw);
    addLog(game, `${player.label} 跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张牌。`);
    emitEvent(game, {
      kind: "skip-draw",
      actorId: player.id,
      label: `${player.label} 选择蓄力`,
      result: `跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张未知牌。`,
      tone: "neutral",
    });
    finishPlayPhase(game);
  } else if (plan.kind === "end") {
    emitEvent(game, {
      kind: "end",
      actorId: player.id,
      label: `${player.label} 结束出牌`,
      result: "未再进行行动，进入弃牌阶段。",
      tone: "neutral",
    });
    finishPlayPhase(game);
  } else if (plan.kind === "move") {
    if (!resolveMoveAction(game, plan.cardId, plan.position)) finishPlayPhase(game);
  } else if (plan.kind === "tackle") {
    if (!resolveTackleAction(game, plan.cardId, plan.targetId)) finishPlayPhase(game);
  } else if (plan.kind === "press") {
    if (!resolvePressAction(game, plan.targetId)) finishPlayPhase(game);
  } else if (plan.kind === "sprint") {
    if (!resolveSprintAction(game, plan.cardId)) finishPlayPhase(game);
  } else if (plan.kind === "supply") {
    if (!resolveSupplyAction(game, plan.cardId)) finishPlayPhase(game);
  } else if (plan.kind === "long-pass") {
    if (!resolveLongPassAction(game, plan.cardId)) finishPlayPhase(game);
  } else if (plan.kind === "save-recycle") {
    if (!resolveSaveRecycle(game, plan.cardId)) finishPlayPhase(game);
  } else if (plan.kind === "flying-kick") {
    if (!resolveFlyingKickAction(game, plan.cardId, plan.targetId)) finishPlayPhase(game);
  } else if (!resolvePassAction(game, plan.cardId, plan.position, humanPlayerId)) {
    finishPlayPhase(game);
  }
}

function runAiSaveResponse(game: GameState) {
  const pending = game.pendingPass;
  if (!pending?.responderId) return;
  const responder = playerById(game, pending.responderId);
  const save = specialCards(responder, "save")[0];
  if (!save) return void declineSaveResponse(game);
  const extras = saveExtraCards(responder, save.id);
  for (let steps = 1; steps <= extras.length; steps += 1) {
    const routes = exactStepPaths(game, responder, steps);
    const destination = pending.path.find((cell) => routes.has(cell));
    if (destination !== undefined) {
      resolveSaveResponse(game, extras.slice(0, steps).map((card) => card.id), destination);
      return;
    }
  }
  declineSaveResponse(game);
}

function runAiDiscard(game: GameState) {
  const playerId = game.discardQueue[0];
  if (!playerId) return;
  const player = playerById(game, playerId);
  const before = countedHandSize(player);
  let safety = 16;
  while (countedHandSize(player) > handLimit(game, player) && safety > 0) {
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
    discardOverflowAction(game, choice.value);
  }
  const discarded = before - countedHandSize(player);
  if (discarded > 0) {
    emitEvent(game, {
      kind: "discard",
      actorId: player.id,
      label: `${player.label} 整理手牌`,
      result: `弃置 ${discarded} 张未知牌，手牌已降至上限。`,
      tone: "neutral",
    });
  }
}

function phaseActorId(game: GameState) {
  if (game.phase === "turn") return activePlayer(game).id;
  if (game.phase === "save-response") return game.pendingPass?.responderId;
  if (game.phase === "discard") return game.discardQueue[0];
  return undefined;
}

function runAiStep(game: GameState, humanPlayerId: string) {
  const actorId = phaseActorId(game);
  if (!actorId || actorId === humanPlayerId) return false;
  if (game.phase === "turn") runAiTurn(game, humanPlayerId);
  else if (game.phase === "save-response") runAiSaveResponse(game);
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
  const [saveDiscardIds, setSaveDiscardIds] = useState<string[]>([]);

  const current = activePlayer(game);
  const responsePlayer = game.phase === "save-response" && game.pendingPass?.responderId
    ? playerById(game, game.pendingPass.responderId)
    : undefined;
  const focusPlayer = game.phase === "discard" && game.discardQueue[0]
    ? playerById(game, game.discardQueue[0])
    : responsePlayer ?? current;
  const actorId = phaseActorId(game);
  const aiThinking = Boolean(actorId && actorId !== humanPlayerId);
  const humanTurn = game.phase === "turn" && current.id === humanPlayerId;
  const humanSaveResponse = game.phase === "save-response" && responsePlayer?.id === humanPlayerId;
  const focusIsHuman = focusPlayer.id === humanPlayerId;
  const selectedCard = current.hand.find(
    (card): card is PlayCard => card.id === selectedCardId && card.kind !== "ball",
  );
  const responseSaveCard = responsePlayer ? specialCards(responsePlayer, "save")[0] : undefined;
  const responseExtraCards = responsePlayer && responseSaveCard ? saveExtraCards(responsePlayer, responseSaveCard.id) : [];

  const validCells = (() => {
    if (humanSaveResponse && responsePlayer && saveDiscardIds.length > 0) {
      return new Set(exactStepPaths(game, responsePlayer, saveDiscardIds.length).keys());
    }
    if (!humanTurn || selectedCard?.kind !== "action") return new Set<number>();
    if (actionMode === "move" && canAct(game)) return movementTargets(game, current, selectedCard.suit);
    if (actionMode === "pass" && hasBall(current) && canAct(game)) return legalPassTargets(game, current, selectedCard.suit, game.turn.longPassReady);
    return new Set<number>();
  })();
  const visibleEvent = game.lastEvent;
  const eventPath = new Set(visibleEvent?.path ?? []);
  const traceSegments = game.traces.flatMap((trace) => {
    const points = trace.kind === "response" && trace.path?.length ? [trace.from, ...trace.path] : [trace.from, trace.to];
    return points.slice(1).map((to, index) => ({ trace, from: points[index], to, segment: index }));
  });

  useEffect(() => {
    if (!actorId || actorId === humanPlayerId) return;
    const delay = game.phase === "turn" || game.phase === "save-response"
      ? AI_TUNING.thinkDelay.turn
      : AI_TUNING.thinkDelay.phase;
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
    setSaveDiscardIds([]);
  }

  function startKickoff() {
    setGame((previous) => {
      const next = structuredClone(previous);
      enterCurrentTurn(next);
      const starter = activePlayer(next);
      emitEvent(next, {
        kind: "kickoff",
        actorId: starter.id,
        to: starter.position,
        ballSquare: starter.position,
        label: `${starter.label} 开球`,
        result: `${describeTeam(starter.team)}获得球权，比赛继续。`,
        tone: "success",
      });
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
      emitEvent(next, {
        kind: "skip-draw",
        actorId: player.id,
        label: `${player.label} 选择蓄力`,
        result: `跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张牌。`,
        tone: "neutral",
      });
      finishPlayPhase(next);
      return next;
    });
    clearSelections();
  }

  function endPlayPhase() {
    if (!humanTurn) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const player = activePlayer(next);
      emitEvent(next, {
        kind: "end",
        actorId: player.id,
        label: `${player.label} 结束出牌`,
        result: "进入弃牌阶段。",
        tone: "neutral",
      });
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
      return resolvePassAction(next, selectedCard.id, position, humanPlayerId) ? next : previous;
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

  function performPress(targetId: string) {
    if (!humanTurn || actionMode !== "press") return;
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolvePressAction(next, targetId) ? next : previous;
    });
    clearSelections();
  }

  function performFlyingKick(targetId: string) {
    if (!humanTurn || selectedCard?.kind !== "special" || selectedCard.special !== "flying-kick") return;
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolveFlyingKickAction(next, selectedCard.id, targetId) ? next : previous;
    });
    clearSelections();
  }

  function performImmediateSpecial() {
    if (!humanTurn || selectedCard?.kind !== "special") return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const success = selectedCard.special === "sprint"
        ? resolveSprintAction(next, selectedCard.id)
        : selectedCard.special === "supply"
          ? resolveSupplyAction(next, selectedCard.id)
          : selectedCard.special === "long-pass"
            ? resolveLongPassAction(next, selectedCard.id)
            : selectedCard.special === "save"
              ? resolveSaveRecycle(next, selectedCard.id)
              : false;
      return success ? next : previous;
    });
    clearSelections();
  }

  function toggleSaveDiscard(cardId: string) {
    if (!humanSaveResponse) return;
    setSaveDiscardIds((ids) => ids.includes(cardId) ? ids.filter((id) => id !== cardId) : [...ids, cardId]);
  }

  function performSave(destination: number) {
    if (!humanSaveResponse || !validCells.has(destination) || saveDiscardIds.length < 1) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolveSaveResponse(next, saveDiscardIds, destination) ? next : previous;
    });
    clearSelections();
  }

  function declineSave() {
    if (!humanSaveResponse) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      return declineSaveResponse(next) ? next : previous;
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
    if (!humanTurn && !humanSaveResponse) return;
    const target = game.players.find((player) => player.position === position);
    if (humanSaveResponse) performSave(position);
    else if (actionMode === "tackle" && target) performTackle(target.id);
    else if (actionMode === "flying-kick" && target) performFlyingKick(target.id);
    else if (actionMode === "press" && target) performPress(target.id);
    else if (actionMode === "move") performMove(position);
    else if (actionMode === "pass") performPass(position);
  }

  const phaseCopy = (() => {
    if (game.phase === "setup") return ["选择角色并布阵", "选择你控制的一名球员；其余五名球员由 AI 控制。"];
    if (game.phase === "kickoff") return [game.kickoffReason, "调整你的球员位置后确认开球；开球者随后抽1张，并在准备阶段获得行动力。"];
    if (game.phase === "turn") {
      const restriction = hasBall(current)
        ? game.turn.acquiredBall
          ? `刚刚获得足球，仍剩 ${game.turn.actionsRemaining} 次行动。`
          : `持球者在准备阶段获得行动力，当前剩余 ${game.turn.actionsRemaining} 点。`
        : `无球队员在准备阶段获得行动力，当前剩余 ${game.turn.actionsRemaining} 点。`;
      return current.id === humanPlayerId
        ? [`${current.label} · 出牌阶段`, `已自动抽1张。${restriction}`]
        : [`${current.label} · AI 出牌阶段`, `已自动抽 1 张未知牌；AI 正在评估剩余 ${game.turn.actionsRemaining} 次行动。`];
    }
    if (game.phase === "save-response" && responsePlayer && game.pendingPass) {
      return responsePlayer.id === humanPlayerId
        ? [`${responsePlayer.label} · 扑救响应`, `选择要额外弃置的牌；弃 X 张即可移动 X 步，随后点击高亮落点。`]
        : [`${responsePlayer.label} · AI 扑救响应`, `传球尚未完成，AI 正在判断能否移动到传球线路。`];
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
          <section
            className={`action-banner ${visibleEvent?.tone ?? "neutral"} ${visibleEvent?.team ?? ""}`}
            role={visibleEvent?.kind === "goal" ? "alert" : "status"}
            aria-live={visibleEvent?.kind === "goal" ? "assertive" : "polite"}
            aria-atomic="true"
          >
            <span>{visibleEvent ? visibleEvent.kind.replace("-", " ").toUpperCase() : "MATCH FEED"}</span>
            <div>
              <strong>{visibleEvent?.label ?? "等待第一步行动"}</strong>
              <p>{visibleEvent?.result ?? "AI 和玩家的移动、传球、上抢与球权变化会显示在这里。"}</p>
            </div>
          </section>
          <div className="pitch-frame">
            <div className="pitch" role="grid" aria-label="8乘8足球棋盘">
              <div className="center-circle" aria-hidden="true" /><div className="halfway-line" aria-hidden="true" />
              <div className="trace-layer" aria-hidden="true">
                {traceSegments.map(({ trace, from, to, segment }) => {
                  const fromX = (from % 8) * 12.5 + 6.25;
                  const fromY = Math.floor(from / 8) * 12.5 + 6.25;
                  const toX = (to % 8) * 12.5 + 6.25;
                  const toY = Math.floor(to / 8) * 12.5 + 6.25;
                  const width = Math.hypot(toX - fromX, toY - fromY);
                  const angle = Math.atan2(toY - fromY, toX - fromX) * 180 / Math.PI;
                  const style = { left: `${fromX}%`, top: `${fromY}%`, width: `${width}%`, transform: `rotate(${angle}deg)` } as CSSProperties;
                  return <span key={`${trace.id}-${segment}`} className={`trace-line ${trace.kind} ${trace.team}`} style={style}><i /></span>;
                })}
              </div>
              {Array.from({ length: 64 }, (_, position) => {
                const player = game.players.find((item) => item.position === position);
                const goal = position === RED_GOAL ? "red" : position === BLUE_GOAL ? "blue" : null;
                const valid = validCells.has(position);
                const setupSelected = player?.id === setupPlayerId && (game.phase === "setup" || game.phase === "kickoff");
                const closeInteractionTarget = humanTurn && player && player.team !== current.team && (
                  ((actionMode === "tackle" || actionMode === "press") && player.hand.length > 0 && isAdjacent(current.position, player.position)) ||
                  (actionMode === "flying-kick" && isStepAdjacent(current.position, player.position))
                );
                const eventFrom = visibleEvent?.from === position;
                const eventTo = visibleEvent?.to === position || visibleEvent?.ballSquare === position;
                const eventRoute = eventPath.has(position);
                return <button
                  key={position}
                  className={`pitch-cell ${(Math.floor(position / 8) + position) % 2 ? "stripe" : ""} ${valid ? "valid" : ""} ${goal ? `goal ${goal}` : ""} ${closeInteractionTarget ? "tackle-target" : ""} ${eventRoute ? "event-route" : ""} ${eventFrom ? "event-from" : ""} ${eventTo ? "event-to" : ""}`}
                  onClick={() => handleCell(position)}
                  aria-label={`${squareName(position)}${player ? `，${player.label}` : ""}${game.looseBall === position ? "，足球落点" : ""}`}
                  role="gridcell"
                >
                  <span className="coordinate">{squareName(position)}</span>
                  {goal && <span className="goal-net"><i /><i /><i /></span>}
                  {game.looseBall === position && <span className="loose-ball" title="无人持有的足球">●</span>}
                  {player && <span className={`player-token ${player.team} ${setupSelected ? "selected" : ""} ${player.id === current.id ? "current" : ""} ${player.id === visibleEvent?.actorId && visibleEvent?.kind !== "goal" ? "event-actor" : ""} ${player.id === visibleEvent?.targetId ? "event-target" : ""}`}>
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
          <section className="phase-card"><p className="section-label">MATCH DIRECTOR</p><h2>{phaseCopy[0]}</h2><p>{phaseCopy[1]}</p><div className="phase-rule"><span>{game.phase === "turn" ? `行动力 ${game.turn.actionsRemaining}` : "LIVE"}</span><i /></div></section>
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
            <button className="draw-action" disabled={game.turn.cardsPlayed !== 0} onClick={skipPlayAndDraw}><span>蓄力</span><strong>+{GAME_BALANCE.skipPlayDraw}</strong><small>尚未行动时跳过整个出牌阶段</small></button>
            {game.turn.longPassReady && <p className="status-chip">长传已准备：下一次 PASS 可越过 1 人，不能射门</p>}
            <div className="action-row"><button className="secondary-action" onClick={endPlayPhase}>结束出牌</button></div>
            {selectedCard?.kind === "action" && <div className="mode-grid">
              <button disabled={!canAct(game)} className={actionMode === "move" ? "active" : ""} onClick={() => setActionMode("move")}>MOVE<small>费用1点行动力</small></button>
              {hasBall(current) && <button disabled={!canAct(game)} className={actionMode === "pass" ? "active" : ""} onClick={() => setActionMode("pass")}>PASS<small>传球后结束出牌</small></button>}
            </div>}
            {current.team !== game.offense && <div className="mode-grid"><button disabled={!canAct(game) || game.turn.pressUsed} className={actionMode === "press" ? "active" : ""} onClick={() => { setSelectedCardId(null); setActionMode("press"); }}>PRESS<small>近身无卡上抢</small></button></div>}
            {selectedCard?.kind === "special" && selectedCard.special === "tackle" && <div className="mode-grid"><button disabled={!canAct(game) || game.turn.tackleUsed} className={actionMode === "tackle" ? "active" : ""} onClick={() => setActionMode("tackle")}>TACKLE<small>双方可用 · 一格内抢牌</small></button></div>}
            {selectedCard?.kind === "special" && selectedCard.special === "flying-kick" && <div className="mode-grid"><button disabled={!canAct(game)} className={actionMode === "flying-kick" ? "active" : ""} onClick={() => setActionMode("flying-kick")}>飞踢<small>一步内 · 下回合行动力−1</small></button></div>}
            {selectedCard?.kind === "special" && ["sprint", "supply", "long-pass"].includes(selectedCard.special) && <button className="primary-action full" disabled={(selectedCard.cost > game.turn.actionsRemaining) || (selectedCard.special === "long-pass" && (!hasBall(current) || game.turn.longPassReady))} onClick={performImmediateSpecial}>使用 {SPECIAL_INFO[selectedCard.special].caption}</button>}
            {selectedCard?.kind === "special" && selectedCard.special === "save" && <button className="primary-action full" disabled={current.team !== game.offense} onClick={performImmediateSpecial}>{current.team === game.offense ? "弃置扑救并抽1张" : "扑救仅在对方Pass时响应"}</button>}
            {actionMode === "move" && <p className="action-hint">点击高亮位置。移动路径经过落地足球时会立即获得足球。</p>}
            {actionMode === "pass" && <p className="action-hint">点击高亮空格或队友传球；任何球员都会阻挡线路，最先挡路的队友可以直接接球。</p>}
            {actionMode === "tackle" && <p className="action-hint">点击王的一格以内的对手；抽到的牌都会加入手牌。</p>}
            {actionMode === "flying-kick" && <p className="action-hint">点击横向或纵向相邻一步的对手；若其持球则直接夺取足球。</p>}
            {actionMode === "press" && <p className="action-hint">点击王的一格以内的对手；只有抽中足球才会拿走，否则原样放回。</p>}
          </section>}

          {humanSaveResponse && responsePlayer && responseSaveCard && <section className="action-card-panel save-response-panel">
            <div className="panel-title-row"><h3>扑救响应</h3><span>PASS 尚未完成</span></div>
            <p className="action-hint">扑救卡会自动弃置。再选择 X 张牌，即可移动 X 步；点击高亮格执行扑救。</p>
            <div className="save-discard-grid">{responseExtraCards.map((card) => <button key={card.id} className={saveDiscardIds.includes(card.id) ? "selected" : ""} onClick={() => toggleSaveDiscard(card.id)}><strong>{card.kind === "action" ? SUIT_INFO[card.suit].icon : SPECIAL_INFO[card.special].icon}</strong><span>{card.kind === "action" ? SUIT_INFO[card.suit].name : SPECIAL_INFO[card.special].name}</span></button>)}</div>
            <p className="response-summary">已选 {saveDiscardIds.length} 张 · 可移动 {saveDiscardIds.length} 步</p>
            <button className="secondary-action full" onClick={declineSave}>放弃扑救，让 Pass 继续</button>
          </section>}

          {game.phase === "discard" && game.discardQueue[0] === humanPlayerId && <section className="action-card-panel"><div className="panel-title-row"><h3>弃牌阶段</h3><span>{countedHandSize(focusPlayer)} / {handLimit(game, focusPlayer)}{hasBall(focusPlayer) ? " + 球" : ""}</span></div><div className="revealed-hand compact">{focusPlayer.hand.map((card) => <button key={card.id} className={card.kind} disabled={card.kind === "ball"} onClick={() => discardOverflow(card.id)}><strong>{card.kind === "ball" ? "●" : card.kind === "action" ? SUIT_INFO[card.suit].icon : SPECIAL_INFO[card.special].icon}</strong><span>{card.kind === "ball" ? "FOOTBALL" : card.kind === "action" ? SUIT_INFO[card.suit].name : SPECIAL_INFO[card.special].name}</span></button>)}</div></section>}

          {game.phase === "gameover" && <section className={`winner-card ${game.winner}`}><span>FULL TIME</span><strong>{game.scores.red} — {game.scores.blue}</strong><button onClick={() => { setGame(createGame()); clearSelections(); setSetupPlayerId(humanPlayerId); }}>再来一局</button></section>}
          <section className="match-log"><div className="panel-title-row"><h3>比赛记录</h3><span>最新在前</span></div><div className="log-scroll">{game.log.map((message, index) => <p key={`${message}-${index}`}><i>{String(game.log.length - index).padStart(2, "0")}</i>{message}</p>)}</div></section>
        </aside>
      </div>

      <section className="hand-dock" aria-label={`${focusPlayer.label} 手牌`}>
        <div className="hand-owner"><span className={`owner-badge ${focusPlayer.team}`}>{focusPlayer.label}</span><div><strong>{focusIsHuman ? "你的手牌" : "AI 手牌"}</strong><small>{focusIsHuman ? "足球不计入手牌上限" : "牌面隐藏 · 持球者仍公开"}</small></div><b>{countedHandSize(focusPlayer)} / {handLimit(game, focusPlayer)}{hasBall(focusPlayer) ? " + 球" : ""}</b></div>
        <div className="card-fan">
          {!focusIsHuman && focusPlayer.hand.map((card, index) => <span key={`${card.id}-${index}`} className="play-card hidden-card" aria-label="AI 暗牌"><span className="card-corner">PASS AI</span><strong>?</strong><h4>HIDDEN</h4><small>UNKNOWN CARD</small></span>)}
          {focusIsHuman && focusPlayer.hand.map((card) => {
            const active = game.phase === "turn" && focusPlayer.id === current.id;
            const selected = active && selectedCardId === card.id;
            const info = card.kind === "ball" ? { name: "BALL", icon: "●", caption: "FOOTBALL" } : card.kind === "action" ? SUIT_INFO[card.suit] : SPECIAL_INFO[card.special];
            return <button key={card.id} className={`play-card ${card.kind} ${selected ? "selected" : ""}`} disabled={!active || card.kind === "ball"} onClick={() => { if (card.kind === "ball") return; setSelectedCardId(selected ? null : card.id); setActionMode(null); }}><span className="card-corner">{info.name}</span>{card.kind !== "ball" && <span className="card-cost" title="行动力费用">{card.cost}</span>}<strong>{info.icon}</strong><h4>{info.caption}</h4><small>{card.kind === "ball" ? "具体位置仅持有者可见" : card.kind === "action" ? "MOVE · PASS" : SPECIAL_INFO[card.special].description}</small></button>;
          })}
        </div>
      </section>
    </main>
  );
}
