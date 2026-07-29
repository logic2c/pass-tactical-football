import type {
  ActionCard,
  ActionTrace,
  BallCard,
  GameState,
  PendingPass,
  PlayCard,
  Player,
  SpecialCard,
  SpecialKind,
  Suit,
  Team,
  TurnState,
  VisualEvent,
} from "./types";
import { GAME_BALANCE, FILES, SUIT_INFO, getTurnOrder, getFormation, describeTeam } from "./constants";
import {
  ALL_GOALS,
  BOARD_HEIGHT,
  BOARD_SIZE,
  BOARD_WIDTH,
  BLUE_GOALS,
  RED_GOALS,
  enemyGoal,
  enemyGoals,
  isInEnemyPenaltyArea,
  isInOwnPenaltyArea,
  isGoal,
  movementPath,
  movementTargets,
  passBlockerCount,
  passBlockedByPlayer,
  passPath,
  wouldExceedDefenderPenaltyLimit,
} from "./game-rules";
import {
  closestDistance,
  goalDistance,
  gridDistance,
  progressGain,
} from "./ai";

// ── Utility ──

export function shuffle<T>(items: T[], random = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function buildDeck(random = Math.random): PlayCard[] {
  const actions: ActionCard[] = (["rock", "bishop", "knight"] as Suit[]).flatMap((suit) =>
    Array.from({ length: GAME_BALANCE.actionCardsPerSuit }, (_, index) => ({
      id: `${suit}-${index + 1}`,
      kind: "action" as const,
      suit,
      cost: 1,
    })),
  );
  return shuffle(actions, random);
}

export function emptyTurn(): TurnState {
  return { actionsRemaining: 0, actionsSpent: 0, tackleUsed: false, acquiredBall: false, cardsPlayed: 0, longPassReady: false };
}

export function createGame(mode: "1v1" | "2v2" | "3v3" | "4v4" = "3v3", random = Math.random): GameState {
  const order = getTurnOrder(mode);
  const formation = getFormation(mode);
  const game: GameState = {
    players: order.map((id) => ({
      id,
      label: id.toUpperCase(),
      team: id.startsWith("r") ? "red" : "blue",
      position: formation[id],
      hand: [],
      nextTurnPenalty: 0,
    })),
    deck: buildDeck(random),
    discard: [],
    offense: "red",
    scores: { red: 0, blue: 0 },
    turnIndex: 0,
    turn: emptyTurn(),
    phase: "setup",
    discardQueue: [],
    log: ["选择你控制的球队并调整己方阵型，然后由 R1 开球。"],
    kickoffReason: "赛前布阵",
    eventSeq: 0,
    traceSeq: 0,
    traces: [],
  };
  game.players.forEach((player) => drawInto(game, player, GAME_BALANCE.startingHand, random));
  game.players[0].hand.push({ id: "football", kind: "ball" });
  return game;
}

export function playerById(game: GameState, id: string) {
  return game.players.find((player) => player.id === id)!;
}

function gameModeFromCount(count: number): "1v1" | "2v2" | "3v3" | "4v4" {
  if (count <= 2) return "1v1";
  if (count <= 4) return "2v2";
  if (count <= 6) return "3v3";
  return "4v4";
}

export function activePlayer(game: GameState) {
  const order = getTurnOrder(gameModeFromCount(game.players.length));
  return playerById(game, order[game.turnIndex]);
}

export function getTurnOrderForGame(game: GameState): string[] {
  return getTurnOrder(gameModeFromCount(game.players.length));
}

export function hasBall(player: Player) {
  return player.hand.some((card) => card.kind === "ball");
}

export function actionCards(player: Player) {
  return player.hand.filter((card): card is ActionCard => card.kind === "action");
}

export function specialCards(player: Player, kind?: SpecialKind) {
  return player.hand.filter(
    (card): card is SpecialCard => card.kind === "special" && (!kind || card.special === kind),
  );
}

export function playableCards(player: Player) {
  return player.hand.filter((card): card is PlayCard => card.kind !== "ball");
}

export function otherTeam(team: Team): Team {
  return team === "red" ? "blue" : "red";
}

export function handLimit(game: GameState, player: Player) {
  return player.team === game.offense ? GAME_BALANCE.handLimit.offense : GAME_BALANCE.handLimit.defense;
}

export function countedHandSize(player: Player) {
  return player.hand.filter((card) => card.kind !== "ball").length;
}

export function squareName(position: number) {
  if (position === BLUE_GOALS[0]) return "蓝方球门 D";
  if (position === BLUE_GOALS[1]) return "蓝方球门 E";
  if (position === RED_GOALS[0]) return "红方球门 D";
  if (position === RED_GOALS[1]) return "红方球门 E";
  const numericRank = BOARD_HEIGHT - Math.floor(position / BOARD_WIDTH);
  const rank = numericRank === 10 ? "X" : String(numericRank);
  return `${FILES[position % BOARD_WIDTH]}${rank}`;
}

export function addLog(game: GameState, message: string) {
  game.log.unshift(message);
  game.log = game.log.slice(0, 32);
}

export function emitEvent(game: GameState, event: Omit<VisualEvent, "id">) {
  game.eventSeq += 1;
  game.lastEvent = { id: game.eventSeq, ...event };
}

export function remainingActionCopy(game: GameState) {
  return game.turn.actionsRemaining > 0
    ? `剩余 ${game.turn.actionsRemaining} 点行动力。`
    : "本回合行动力已用完。";
}

export function drawInto(game: GameState, player: Player, count: number, random = Math.random) {
  for (let index = 0; index < count; index += 1) {
    if (game.deck.length === 0 && game.discard.length > 0) {
      game.deck = shuffle(game.discard, random);
      game.discard = [];
      addLog(game, "弃牌堆已重新洗成牌库。");
    }
    const card = game.deck.pop();
    if (!card) break;
    player.hand.push(card);
  }
}

// ── Turn / Phase ──

export function enterCurrentTurn(game: GameState) {
  const player = activePlayer(game);
  const enteringFromInitialSetup = game.phase === "setup";
  if (enteringFromInitialSetup) {
    const defenders = game.players.filter((candidate) => candidate.team !== game.offense);
    defenders.forEach((defender) => drawInto(game, defender, 1));
    if (defenders.length > 0) addLog(game, `${describeTeam(defenders[0].team)}作为初始防守方，每名球员额外补充 1 张牌。`);
  }
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
    acquiredBall: false,
    cardsPlayed: 0,
    longPassReady: false,
  };
  addLog(game, `${player.label} 抽取 ${GAME_BALANCE.turnDraw} 张牌，并在准备阶段获得 ${game.turn.actionsRemaining} 点行动力${penalty ? `（飞踢影响 −${penalty}）` : ""}。`);
}

export function nextTurn(game: GameState) {
  const order = getTurnOrderForGame(game);
  game.turnIndex = (game.turnIndex + 1) % order.length;
  enterCurrentTurn(game);
}

export function finishPlayPhase(game: GameState) {
  const player = activePlayer(game);
  if (countedHandSize(player) > handLimit(game, player)) {
    game.phase = "discard";
    game.discardQueue = [player.id];
    game.discardResume = "next-turn";
    addLog(game, `${player.label} 进入弃牌阶段，需要将手牌弃至上限。`);
  } else {
    addLog(game, `${player.label} 完成弃牌阶段。`);
    finishTurnAfterLimits(game, player);
  }
}

export function hasDefenderPenaltyFoul(game: GameState, player: Player) {
  if (player.team === game.offense || !isInOwnPenaltyArea(player.team, player.position)) return false;
  return game.players.filter((candidate) =>
    candidate.team === player.team && isInOwnPenaltyArea(player.team, candidate.position),
  ).length > 1;
}

export function finishTurnAfterLimits(game: GameState, player: Player) {
  if (hasDefenderPenaltyFoul(game, player)) {
    const receiverId = nextOpponent(game, player.id, game.offense);
    addLog(game, `${describeTeam(player.team)}禁区内仍有多名防守球员，判罚犯规。`);
    kickoff(game, receiverId, "禁区超员犯规后开球：", player.id, true);
    emitEvent(game, {
      kind: "foul",
      actorId: player.id,
      label: `${player.label} 禁区超员犯规`,
      result: `${describeTeam(game.offense)}获得球权，双方回到默认阵型并从中场重新开球。`,
      tone: "failure",
      team: player.team,
    });
    return;
  }
  nextTurn(game);
}

export function nextOpponent(game: GameState, fromId: string, team: Team) {
  const order = getTurnOrderForGame(game);
  const start = order.indexOf(fromId);
  for (let step = 1; step <= order.length; step += 1) {
    const id = order[(start + step) % order.length];
    if (playerById(game, id).team === team) return id;
  }
  return team === "red" ? "r1" : "b1";
}

export function resetFormation(game: GameState) {
  const formation = getFormation(gameModeFromCount(game.players.length));
  game.players.forEach((player) => {
    player.position = formation[player.id];
  });
  game.traces = [];
  game.pendingPass = undefined;
}

export function moveBallTo(game: GameState, recipientId: string) {
  let ball: BallCard | undefined;
  game.players.forEach((player) => {
    const index = player.hand.findIndex((card) => card.kind === "ball");
    if (index >= 0) ball = player.hand.splice(index, 1)[0] as BallCard;
  });
  game.looseBall = undefined;
  playerById(game, recipientId).hand.push(ball ?? { id: "football", kind: "ball" });
}

export function kickoff(game: GameState, receiverId: string, reason: string, endingPlayerId?: string, fromMidfield = false) {
  moveBallTo(game, receiverId);
  game.offense = playerById(game, receiverId).team;
  const order = getTurnOrderForGame(game);
  game.turnIndex = order.indexOf(receiverId);
  game.kickoffReason = reason;
  game.discardQueue = [];
  game.discardResume = undefined;
  resetFormation(game);
  if (fromMidfield) playerById(game, receiverId).position = playerById(game, receiverId).team === "red" ? 44 : 35;
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

export function scoreGoal(
  game: GameState,
  scorer: Player,
  method: "移动" | "传球",
  origin = scorer.position,
  route: number[] = [enemyGoal(scorer.team)],
  targetGoal: number = enemyGoal(scorer.team),
) {
  const scorerId = scorer.id;
  const goal = targetGoal;
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

// ── Action helpers ──

export function isOwnHalf(player: Player, position: number) {
  const row = Math.floor(position / BOARD_WIDTH);
  return player.team === "red" ? row >= BOARD_HEIGHT / 2 : row < BOARD_HEIGHT / 2;
}

export function isLegalSetupPosition(game: GameState, player: Player, position: number) {
  return Number.isInteger(position) &&
    position >= 0 &&
    position < BOARD_SIZE &&
    isOwnHalf(player, position) &&
    !game.players.some((candidate) => candidate.id !== player.id && candidate.position === position) &&
    !wouldExceedDefenderPenaltyLimit(game, player, position);
}

export function canAct(game: GameState) {
  return game.turn.actionsRemaining > 0;
}

export function spendAction(game: GameState, cost = 1) {
  if (game.turn.actionsRemaining < cost) return false;
  game.turn.actionsRemaining -= cost;
  game.turn.actionsSpent += cost;
  game.turn.cardsPlayed += 1;
  return true;
}

export function shouldAutoFinishTurn(game: GameState) {
  if (game.phase !== "turn" || game.turn.actionsRemaining !== 0) return false;
  return !activePlayer(game).hand.some((card) => card.kind !== "ball" && card.cost === 0);
}

export function autoFinishTurnIfNeeded(game: GameState) {
  if (!shouldAutoFinishTurn(game)) return false;
  addLog(game, `${activePlayer(game).label} 行动力已耗尽且没有 0 点行动力卡牌，自动进入弃牌阶段。`);
  finishPlayPhase(game);
  return true;
}

export function recordTrace(game: GameState, trace: Omit<ActionTrace, "id">) {
  game.traceSeq += 1;
  game.traces.push({ id: game.traceSeq, ...trace });
}

export function markBallAcquired(game: GameState) {
  game.turn.acquiredBall = true;
}

export function isAdjacent(left: number, right: number) {
  const rowDistance = Math.abs(Math.floor(left / BOARD_WIDTH) - Math.floor(right / BOARD_WIDTH));
  const colDistance = Math.abs((left % BOARD_WIDTH) - (right % BOARD_WIDTH));
  return Math.max(rowDistance, colDistance) === 1;
}

export function isStepAdjacent(left: number, right: number) {
  const rowDistance = Math.abs(Math.floor(left / BOARD_WIDTH) - Math.floor(right / BOARD_WIDTH));
  const colDistance = Math.abs((left % BOARD_WIDTH) - (right % BOARD_WIDTH));
  return rowDistance + colDistance === 1;
}

export function exactStepPaths(game: GameState, player: Player, steps: number) {
  const occupied = new Set(game.players.filter((item) => item.id !== player.id).map((item) => item.position));
  let frontier = new Map<number, number[]>([[player.position, []]]);
  for (let step = 0; step < steps; step += 1) {
    const nextFrontier = new Map<number, number[]>();
    frontier.forEach((path, position) => {
      const row = Math.floor(position / BOARD_WIDTH);
      const col = position % BOARD_WIDTH;
      [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([rowDelta, colDelta]) => {
        const nextRow = row + rowDelta;
        const nextCol = col + colDelta;
        if (nextRow < 0 || nextRow >= BOARD_HEIGHT || nextCol < 0 || nextCol >= BOARD_WIDTH) return;
        const next = nextRow * BOARD_WIDTH + nextCol;
        if (occupied.has(next) || isGoal(next) || nextFrontier.has(next)) return;
        nextFrontier.set(next, [...path, next]);
      });
    });
    frontier = nextFrontier;
  }
  frontier.delete(player.position);
  return frontier;
}

export function legalPassTargets(game: GameState, passer: Player, suit: Suit, longPass = false) {
  const targets = new Set<number>();
  for (const position of [...Array.from({ length: BOARD_SIZE }, (_, index) => index), ...ALL_GOALS]) {
    if (position === passer.position) continue;
    const occupant = game.players.find((player) => player.position === position);
    if (occupant && occupant.team !== passer.team) continue;
    if (isGoal(position) && !enemyGoals(passer.team).includes(position)) continue;
    if (isGoal(position) && isInEnemyPenaltyArea(passer.team, passer.position)) continue;
    if (longPass && isGoal(position)) continue;
    const path = passPath(passer.position, position, suit);
    if (!path) continue;
    const blocked = longPass
      ? passBlockerCount(passer.position, position, suit, game.players) > 1
      : passBlockedByPlayer(passer.position, position, suit, game.players);
    if (!blocked) targets.add(position);
  }

  // Knight passes cross one orthogonal square first.
  if (suit === "knight") {
    for (let position = 0; position < BOARD_SIZE; position += 1) {
      const path = passPath(passer.position, position, suit);
      if (!path?.length) continue;
      const firstPlayer = game.players.find((player) => player.position === path[0]);
      if (firstPlayer?.team === passer.team && (!longPass || firstPlayer.position !== enemyGoal(passer.team))) targets.add(firstPlayer.position);
    }
  }
  return targets;
}

export function passRoute(from: number, to: number, suit: Suit) {
  const path = passPath(from, to, suit) ?? [];
  return [...path, to].filter((cell, index, cells) => cells.indexOf(cell) === index);
}

export function saveExtraCards(player: Player, saveCardId?: string) {
  return player.hand.filter((card): card is PlayCard => card.kind !== "ball" && card.id !== saveCardId);
}

export function eligibleSaveResponders(game: GameState, pending: PendingPass) {
  const passer = playerById(game, pending.passerId);
  return game.players.filter((player) => {
    const save = specialCards(player, "save")[0];
    return player.team !== passer.team && isOwnHalf(player, player.position) && Boolean(save) && saveExtraCards(player, save?.id).length > 0;
  });
}

// ── Resolvers ──

export function takeSpecialCard(game: GameState, player: Player, cardId: string, kind: SpecialKind) {
  const index = player.hand.findIndex((card) => card.id === cardId && card.kind === "special" && card.special === kind);
  if (index < 0) return undefined;
  const [card] = player.hand.splice(index, 1) as SpecialCard[];
  game.discard.push(card);
  return card;
}

export function resolveMoveAction(game: GameState, cardId: string, position: number) {
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

export function resolveTackleAction(game: GameState, cardId: string, targetId: string, random = Math.random) {
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
  const takenIndex = Math.floor(random() * target.hand.length);
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

export function resolvePressAction(game: GameState, costCardId: string, targetId: string, random = Math.random) {
  const player = activePlayer(game);
  const target = game.players.find((item) => item.id === targetId);
  const costIndex = player.hand.findIndex((card) => card.id === costCardId && card.kind !== "ball");
  if (
    !canAct(game) ||
    player.team === game.offense ||
    costIndex < 0 ||
    !target ||
    target.team === player.team ||
    !hasBall(target) ||
    !isAdjacent(player.position, target.position)
  ) return false;
  if (!spendAction(game, 1)) return false;
  const [costCard] = player.hand.splice(costIndex, 1) as PlayCard[];
  game.discard.push(costCard);
  const takenIndex = Math.floor(random() * target.hand.length);
  const [inspected] = target.hand.splice(takenIndex, 1);
  if (inspected.kind === "ball") {
    const ball = inspected;
    player.hand.push(ball);
    game.offense = player.team;
    markBallAcquired(game);
    addLog(game, `${player.label} 弃置 1 张牌上抢 ${target.label} 并抽中足球！${remainingActionCopy(game)}`);
  } else {
    game.discard.push(inspected);
    addLog(game, `${player.label} 弃置 1 张牌上抢 ${target.label}，并弃掉目标 1 张未知牌。`);
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
      : `双方各弃置 1 张非足球牌。${remainingActionCopy(game)}`,
    tone: inspected.kind === "ball" ? "success" : "failure",
  });
  return true;
}

export function resolveSprintAction(game: GameState, cardId: string) {
  const player = activePlayer(game);
  const card = takeSpecialCard(game, player, cardId, "sprint");
  if (!card || !spendAction(game, card.cost)) return false;
  game.turn.actionsRemaining += 1;
  addLog(game, `${player.label} 使用冲刺，本回合额外获得 1 点行动力。`);
  emitEvent(game, { kind: "sprint", actorId: player.id, label: `${player.label} 使用冲刺`, result: `行动力 +1，当前剩余 ${game.turn.actionsRemaining} 点。`, tone: "success" });
  return true;
}

export function resolveSupplyAction(game: GameState, cardId: string, random = Math.random) {
  const player = activePlayer(game);
  const index = player.hand.findIndex((card) => card.id === cardId && card.kind === "special" && card.special === "supply");
  if (index < 0 || game.turn.actionsRemaining < 1) return false;
  const card = takeSpecialCard(game, player, cardId, "supply")!;
  if (!spendAction(game, card.cost)) return false;
  drawInto(game, player, 2, random);
  addLog(game, `${player.label} 使用补给并抽取 2 张牌。`);
  emitEvent(game, { kind: "supply", actorId: player.id, label: `${player.label} 使用补给`, result: `抽取 2 张牌。${remainingActionCopy(game)}`, tone: "neutral" });
  return true;
}

export function resolveLongPassAction(game: GameState, cardId: string) {
  const player = activePlayer(game);
  if (!hasBall(player) || game.turn.longPassReady || actionCards(player).length === 0) return false;
  const card = takeSpecialCard(game, player, cardId, "long-pass");
  if (!card || !spendAction(game, card.cost)) return false;
  game.turn.longPassReady = true;
  addLog(game, `${player.label} 准备长传：本回合下一次 Pass 可以越过 1 名球员，但不能射门。`);
  emitEvent(game, { kind: "long-pass", actorId: player.id, label: `${player.label} 准备长传`, result: "下一次 Pass 可越过 1 名球员，但不能传入球门。", tone: "success" });
  return true;
}

export function resolveSaveRecycle(game: GameState, cardId: string, random = Math.random) {
  const player = activePlayer(game);
  if (player.team !== game.offense) return false;
  const card = takeSpecialCard(game, player, cardId, "save");
  if (!card || !spendAction(game, card.cost)) return false;
  drawInto(game, player, 1, random);
  addLog(game, `${player.label} 作为进攻方弃置扑救并抽取 1 张牌。`);
  emitEvent(game, { kind: "save", actorId: player.id, label: `${player.label} 更换扑救`, result: "不消耗行动力，弃置扑救并抽取 1 张牌。", tone: "neutral" });
  return true;
}

export function resolveFlyingKickAction(game: GameState, cardId: string, targetId: string) {
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

export function completePendingPass(game: GameState, prefix = "") {
  const pending = game.pendingPass;
  if (!pending) return false;
  const passer = playerById(game, pending.passerId);
  const recipient = game.players.find((player) => player.position === pending.to && player.team === passer.team);
  const ballIndex = passer.hand.findIndex((item) => item.kind === "ball");
  if (ballIndex < 0) return false;
  const [ball] = passer.hand.splice(ballIndex, 1) as BallCard[];
  game.pendingPass = undefined;
  if (isGoal(pending.to)) {
    scoreGoal(game, passer, "传球", pending.from, pending.path, pending.to);
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

export function resolvePassAction(game: GameState, cardId: string, position: number, humanPlayerIds?: string | string[]) {
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

  game.pendingPass = { passerId: passer.id, from, to: position, suit: used.suit, path, longPass };
  const responders = eligibleSaveResponders(game, game.pendingPass);
  const controlledIds = typeof humanPlayerIds === "string" ? [humanPlayerIds] : humanPlayerIds ?? [];
  const humanResponder = responders.find((player) => controlledIds.includes(player.id));
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

export function resolveSaveResponse(game: GameState, extraCardIds: string[], destination: number) {
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

export function declineSaveResponse(game: GameState) {
  const responder = game.pendingPass?.responderId ? playerById(game, game.pendingPass.responderId) : undefined;
  return completePendingPass(game, responder ? `${responder.label} 放弃扑救；` : "");
}

export function discardOverflowAction(game: GameState, cardId: string) {
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
      finishTurnAfterLimits(game, player);
    }
  }
  return true;
}

// ── AI Scoring ──

export function cardPreservationPenalty(player: Player, card: ActionCard) {
  const sameSuit = actionCards(player).filter((item) => item.suit === card.suit).length;
  return sameSuit <= 1 ? 1.1 : sameSuit === 2 ? 0.45 : 0.1;
}

export function scoreMove(game: GameState, player: Player, position: number, card: ActionCard) {
  const holder = game.players.find(hasBall);
  const enemies = game.players.filter((item) => item.team !== player.team).map((item) => item.position);
  const path = movementPath(player.position, position, card.suit) ?? [];
  const collectsBall = game.looseBall !== undefined && path.includes(game.looseBall);
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

export function scorePassTarget(game: GameState, passer: Player, position: number, card: ActionCard) {
  if (isGoal(position)) return 38 - cardPreservationPenalty(passer, card);
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

// Re-export game-rules functions that external consumers use via game-engine
export { isGoal, movementTargets, movementPath, enemyGoal } from "./game-rules";
