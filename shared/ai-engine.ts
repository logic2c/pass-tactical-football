import type { AiTurnPlan, GameState, Player, Suit } from "./types";
import { AI_TUNING, GAME_BALANCE, SUIT_INFO } from "./constants";
import { gridDistance, weightedAiChoice, weightedTopBandAiChoice } from "./ai";
import type { AiCandidate } from "./ai";
import { enemyGoals, isGoal, isInEnemyPenaltyArea, isInOwnPenaltyArea, movementPath, passPath } from "./game-rules";
import {
  actionCards,
  activePlayer,
  addLog,
  autoFinishTurnIfNeeded,
  canAct,
  cardPreservationPenalty,
  countedHandSize,
  declineSaveResponse,
  discardOverflowAction,
  drawInto,
  emitEvent,
  exactStepPaths,
  finishPlayPhase,
  handLimit,
  hasBall,
  isAdjacent,
  isStepAdjacent,
  legalPassTargets,
  movementTargets,
  getTurnOrderForGame,
  playerById,
  playableCards,
  resolveFlyingKickAction,
  resolveLongPassAction,
  resolveMoveAction,
  resolvePassAction,
  resolvePressAction,
  resolveSaveRecycle,
  resolveSaveResponse,
  resolveSprintAction,
  resolveSupplyAction,
  resolveTackleAction,
  saveExtraCards,
  scoreMove,
  scorePassTarget,
  specialCards,
  squareName,
} from "./game-engine";

const SUITS: Suit[] = ["rock", "bishop", "knight"];

function topCandidates<T>(candidates: AiCandidate<T>[], count = 3) {
  return [...candidates].sort((left, right) => right.score - left.score).slice(0, count);
}

export function defensiveResponsibilityIds(game: GameState, player: Player) {
  const order = getTurnOrderForGame(game);
  const start = order.indexOf(player.id);
  const targets: string[] = [];
  for (let offset = 1; offset < order.length; offset += 1) {
    const candidate = playerById(game, order[(start + offset) % order.length]);
    if (candidate.team === player.team) break;
    targets.push(candidate.id);
  }
  return targets;
}

function nextTeammate(game: GameState, player: Player) {
  const order = getTurnOrderForGame(game);
  const start = order.indexOf(player.id);
  for (let offset = 1; offset < order.length; offset += 1) {
    const candidate = playerById(game, order[(start + offset) % order.length]);
    if (candidate.team === player.team) return candidate;
  }
  return undefined;
}

function canCollectLooseBall(game: GameState, player: Player, landing: number, exactFriendlyKnowledge: boolean) {
  if (countedHandSize(player) === 0) return false;
  const suits = exactFriendlyKnowledge
    ? [...new Set(actionCards(player).map((card) => card.suit))]
    : SUITS;
  return suits.some((suit) => [...movementTargets(game, player, suit)].some((destination) =>
    movementPath(player.position, destination, suit)?.includes(landing),
  ));
}

export function firstLikelyLooseBallCollector(game: GameState, passer: Player, landing: number) {
  const order = getTurnOrderForGame(game);
  const start = order.indexOf(passer.id);
  for (let offset = 1; offset < order.length; offset += 1) {
    const candidate = playerById(game, order[(start + offset) % order.length]);
    if (canCollectLooseBall(game, candidate, landing, candidate.team === passer.team)) return candidate;
  }
  return undefined;
}

function potentialShotLanes(game: GameState, attacker: Player) {
  if (isInEnemyPenaltyArea(attacker.team, attacker.position)) return [];
  return SUITS.flatMap((suit) => enemyGoals(attacker.team).flatMap((goal) => {
    const path = passPath(attacker.position, goal, suit);
    if (!path || path.some((cell) => game.players.some((player) => player.id !== attacker.id && player.position === cell))) return [];
    return [{ suit, goal, path }];
  }));
}

function responsibilityMoveScore(game: GameState, player: Player, position: number) {
  const targets = defensiveResponsibilityIds(game, player).map((id) => playerById(game, id));
  const holder = game.players.find((candidate) => candidate.team !== player.team && hasBall(candidate));
  return targets.reduce((score, target) => {
    const closesTarget = gridDistance(player.position, target.position) - gridDistance(position, target.position);
    const marksTarget = gridDistance(position, target.position) <= 1 ? 6 : 0;
    const blocksPass = holder && SUITS.some((suit) => passPath(holder.position, target.position, suit)?.includes(position)) ? 8 : 0;
    return score + closesTarget * 2.5 + marksTarget + blocksPass;
  }, 0);
}

function urgentDefenseMoveScore(game: GameState, player: Player, position: number) {
  const holder = game.players.find((candidate) => candidate.team !== player.team && hasBall(candidate));
  if (!holder) return 0;
  const lanes = potentialShotLanes(game, holder);
  if (lanes.length === 0) return 0;
  const blocks = lanes.filter((lane) => lane.path.includes(position)).length;
  const closesHolder = gridDistance(player.position, holder.position) - gridDistance(position, holder.position);
  return blocks * 38 + (gridDistance(position, holder.position) <= 1 ? 14 : 0) + closesHolder * 2;
}

function attackingSupportMoveScore(game: GameState, player: Player, position: number) {
  if (player.team !== game.offense || hasBall(player)) return 0;
  const holder = game.players.find((candidate) => candidate.team === player.team && hasBall(candidate));
  if (!holder) return 0;
  const simulated = structuredClone(game);
  const simulatedPlayer = playerById(simulated, player.id);
  simulatedPlayer.position = position;
  const simulatedHolder = playerById(simulated, holder.id);
  const becomesReceiver = actionCards(simulatedHolder).some((card) =>
    legalPassTargets(simulated, simulatedHolder, card.suit, simulated.turn.longPassReady).has(position),
  );
  const shotFollowUp = potentialShotLanes(simulated, simulatedPlayer).length > 0;
  const nextReceiver = nextTeammate(game, holder)?.id === player.id;
  return (becomesReceiver ? 9 : 0) + (shotFollowUp ? 14 : 0) + (becomesReceiver && nextReceiver ? 5 : 0);
}

function logAiSelection<T>(game: GameState, player: { label: string }, selection: { value: T; score: number; probability: number; reason: string }, label: string) {
  const probability = Math.max(1, Math.round(selection.probability * 100));
  const note = `${player.label} · ${label}：${selection.reason}（本次权重 ${probability}%）`;
  game.aiNote = note;
  addLog(game, `AI 判断：${note}`);
}

export function runAiTurn(game: GameState, humanPlayerIds: string[], random = Math.random) {
  const player = activePlayer(game);
  const actions = actionCards(player);
  const choices: AiCandidate<AiTurnPlan>[] = [];
  const hasPass = hasBall(player) && actions.some((card) => legalPassTargets(game, player, card.suit, game.turn.longPassReady).size > 0);
  const penaltyFoulRisk = player.team !== game.offense &&
    isInOwnPenaltyArea(player.team, player.position) &&
    game.players.some((candidate) =>
      candidate.id !== player.id &&
      candidate.team === player.team &&
      isInOwnPenaltyArea(player.team, candidate.position),
    );
  const enemyHolder = game.players.find((candidate) => candidate.team !== player.team && hasBall(candidate));
  const urgentShotThreat = Boolean(enemyHolder && potentialShotLanes(game, enemyHolder).length > 0);

  // A legal shot is never traded for a merely promising positional play. Keep
  // weighted choice only between equivalent scoring cards/goal squares.
  if (hasBall(player) && canAct(game)) {
    const goalPlans: AiCandidate<AiTurnPlan>[] = [];
    actions.forEach((card) => {
      legalPassTargets(game, player, card.suit, game.turn.longPassReady).forEach((position) => {
        if (!isGoal(position)) return;
        goalPlans.push({
          value: { kind: "pass", cardId: card.id, position },
          score: scorePassTarget(game, player, position, card),
          reason: "线路无防守者阻挡，直接射门",
        });
      });
    });
    const goalChoice = weightedAiChoice(goalPlans, AI_TUNING.detailTemperature, random);
    if (goalChoice?.value.kind === "pass") {
      logAiSelection(game, player, goalChoice, "射门");
      if (!resolvePassAction(game, goalChoice.value.cardId, goalChoice.value.position, humanPlayerIds)) finishPlayPhase(game);
      return;
    }
  }

  choices.push({
    value: { kind: "end" },
    score: !canAct(game) ? 10 : penaltyFoulRisk || urgentShotThreat ? -100 : game.turn.actionsSpent >= 2 ? 5.2 : hasBall(player) && hasPass ? -1 : 1.3,
    reason: !canAct(game) ? "行动点已经用完" : penaltyFoulRisk ? "当前结束会造成禁区超员犯规" : "保留剩余手牌并结束出牌阶段",
  });
  if (game.turn.cardsPlayed === 0) {
    choices.push({
      value: { kind: "skip-draw" },
      score: penaltyFoulRisk || urgentShotThreat ? -100 : countedHandSize(player) <= 3 ? 2.8 : countedHandSize(player) < handLimit(game, player) ? 1.4 : -2.5,
      reason: penaltyFoulRisk ? "当前跳过会造成禁区超员犯规" : "跳过出牌阶段，再补充两张牌",
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
        const path = movementPath(player.position, position, card.suit) ?? [];
        const collectsLooseBall = game.looseBall !== undefined && path.includes(game.looseBall);
        const exitsCrowdedPenalty = penaltyFoulRisk && !isInOwnPenaltyArea(player.team, position);
        const ballHolderEntersEnemyPenalty = hasBall(player) &&
          !isInEnemyPenaltyArea(player.team, player.position) &&
          isInEnemyPenaltyArea(player.team, position);
        movePlans.push({
          value: { kind: "move", cardId: card.id, position },
          score: scoreMove(game, player, position, card) +
            (collectsLooseBall ? 42 : 0) +
            (exitsCrowdedPenalty ? 70 : 0) -
            (ballHolderEntersEnemyPenalty ? 60 : 0) +
            (player.team !== game.offense ? responsibilityMoveScore(game, player, position) : 0) +
            urgentDefenseMoveScore(game, player, position) +
            attackingSupportMoveScore(game, player, position),
          reason: collectsLooseBall
            ? `移动经过 ${squareName(game.looseBall!)} 争夺足球`
            : exitsCrowdedPenalty
              ? `离开己方禁区，避免禁区超员犯规`
              : ballHolderEntersEnemyPenalty
                ? `进入对方禁区会失去直接射门空间`
            : `${player.team === game.offense ? "推进" : "回防"}到 ${squareName(position)}`,
        });
      });
    });
    choices.push(...topCandidates(movePlans));

    if (player.team !== game.offense && actions.length > 0) {
      const suitCounts = new Map<string, number>();
      actions.forEach((card) => suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1));
      const pressPlans = game.players
        .filter((target) => target.team !== player.team && hasBall(target) && isAdjacent(player.position, target.position))
        .flatMap<AiCandidate<AiTurnPlan>>((target) => actions.map((costCard) => {
          const chance = 1 / target.hand.length;
          const duplicates = suitCounts.get(costCard.suit) ?? 1;
          return {
            value: { kind: "press", cardId: costCard.id, targetId: target.id },
            score: 2.4 + chance * 14 + duplicates * 1.8 - cardPreservationPenalty(player, costCard) * 2.2 + (urgentShotThreat ? 28 : 0),
            reason: `弃置重复度较高的行动牌上抢 ${target.label}，抢到足球的估计概率 ${Math.round(chance * 100)}%`,
          };
        }));
      choices.push(...topCandidates(pressPlans, 2));
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
              score: 2.4 + chance * 14 + (hasBall(target) ? 3.5 : 0) + (hasBall(target) && urgentShotThreat ? 28 : 0),
              reason: hasBall(target)
                ? `尝试从 ${target.label} 手牌中抢到足球，估计概率 ${Math.round(chance * 100)}%`
                : `尝试削弱 ${target.label} 的手牌`,
            };
          });
        choices.push(...topCandidates(tacklePlans, 2));
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
          score: hasBall(target) ? 20 + (urgentShotThreat ? 28 : 0) : 5.2,
          reason: hasBall(target) ? `飞踢 ${target.label} 并直接夺取足球` : `压低 ${target.label} 下回合行动力`,
      }));
      choices.push(...topCandidates(kickPlans, 2));
    }
  }

  if (hasBall(player) && canAct(game)) {
    const passPlans: AiCandidate<AiTurnPlan>[] = [];
    actions.forEach((card) => {
      legalPassTargets(game, player, card.suit, game.turn.longPassReady).forEach((position) => {
        const directReceiver = game.players.find((target) => target.position === position && target.team === player.team);
        const collector = directReceiver ? undefined : firstLikelyLooseBallCollector(game, player, position);
        const ownCollector = collector?.team === player.team;
        const plannedReceiver = directReceiver ?? (ownCollector ? collector : undefined);
        const receiverBonus = plannedReceiver?.id === nextTeammate(game, player)?.id ? 8 : 0;
        const looseBallScore = directReceiver ? 0 : ownCollector ? 24 : collector ? -55 : -8;
        passPlans.push({
          value: { kind: "pass", cardId: card.id, position },
          score: scorePassTarget(game, player, position, card) + looseBallScore + receiverBonus,
          reason: isGoal(position)
            ? "线路无防守者阻挡，直接射门"
            : directReceiver
              ? `直接传给 ${directReceiver.label}`
              : ownCollector
                ? `把足球送到 ${squareName(position)}，预计由 ${collector!.label} 先接应`
                : collector
                  ? `${squareName(position)} 可能被 ${collector.label} 抢先拿到，降低选择优先级`
                  : `把足球送到 ${squareName(position)}，等待后续接应`,
        });
      });
    });
    choices.push(...topCandidates(passPlans));
  }

  // The engine is called again after every resolved action. Keeping several
  // strong candidates here therefore creates a lightweight two-step plan:
  // positioning is scored for the next pass/shot, then the new state is
  // evaluated before the remaining action point is spent.
  const selection = weightedTopBandAiChoice(choices, 1.15, random, 3, 4);
  if (!selection) return finishPlayPhase(game);
  const labels: Record<string, string> = { "skip-draw": "战术整备", end: "结束出牌", move: "移动", tackle: "使用抢断卡", press: "近身上抢", pass: "落点传球", sprint: "冲刺", supply: "补给", "long-pass": "准备长传", "save-recycle": "更换扑救", "flying-kick": "飞踢" };
  logAiSelection(game, player, selection, labels[selection.value.kind] ?? selection.value.kind);
  const plan = selection.value;
  if (plan.kind === "skip-draw") {
    drawInto(game, player, GAME_BALANCE.skipPlayDraw, random);
    addLog(game, `${player.label} 跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张牌。`);
    emitEvent(game, {
      kind: "skip-draw",
      actorId: player.id,
      label: `${player.label} 选择战术整备`,
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
    if (!resolveTackleAction(game, plan.cardId, plan.targetId, random)) finishPlayPhase(game);
  } else if (plan.kind === "press") {
    if (!resolvePressAction(game, plan.cardId, plan.targetId, random)) finishPlayPhase(game);
  } else if (plan.kind === "sprint") {
    if (!resolveSprintAction(game, plan.cardId)) finishPlayPhase(game);
  } else if (plan.kind === "supply") {
    if (!resolveSupplyAction(game, plan.cardId, random)) finishPlayPhase(game);
  } else if (plan.kind === "long-pass") {
    if (!resolveLongPassAction(game, plan.cardId)) finishPlayPhase(game);
  } else if (plan.kind === "save-recycle") {
    if (!resolveSaveRecycle(game, plan.cardId, random)) finishPlayPhase(game);
  } else if (plan.kind === "flying-kick") {
    if (!resolveFlyingKickAction(game, plan.cardId, plan.targetId)) finishPlayPhase(game);
  } else if (!resolvePassAction(game, plan.cardId, plan.position, humanPlayerIds)) {
    finishPlayPhase(game);
  }
  autoFinishTurnIfNeeded(game);
}

export function runAiSaveResponse(game: GameState) {
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

export function runAiDiscard(game: GameState, random = Math.random) {
  const playerId = game.discardQueue[0];
  if (!playerId) return;
  const player = playerById(game, playerId);
  const before = countedHandSize(player);
  let safety = 16;
  while (countedHandSize(player) > handLimit(game, player) && safety > 0) {
    safety -= 1;
    const actions = actionCards(player);
    const suitCounts = new Map<string, number>();
    actions.forEach((card) => suitCounts.set(card.suit, (suitCounts.get(card.suit) ?? 0) + 1));
    const options = playableCards(player).map<AiCandidate<string>>((card) => ({
      value: card.id,
      score: card.kind === "special"
        ? specialCards(player, card.special).length > 1 ? 5 : 0.8
        : (suitCounts.get(card.suit) ?? 1) * 1.4 - cardPreservationPenalty(player, card),
      reason: card.kind === "special" ? "保留至少一张特殊卡" : `整理重复的 ${SUIT_INFO[card.suit].name}`,
    }));
    const choice = weightedAiChoice(options, AI_TUNING.discardTemperature, random);
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

export function phaseActorId(game: GameState) {
  if (game.phase === "turn") return activePlayer(game).id;
  if (game.phase === "save-response") return game.pendingPass?.responderId;
  if (game.phase === "discard") return game.discardQueue[0];
  return undefined;
}

export function runAiStep(game: GameState, humanPlayerIds: string[], random = Math.random) {
  const actorId = phaseActorId(game);
  if (!actorId || humanPlayerIds.includes(actorId)) return false;
  if (game.phase === "turn") runAiTurn(game, humanPlayerIds, random);
  else if (game.phase === "save-response") runAiSaveResponse(game);
  else if (game.phase === "discard") runAiDiscard(game, random);
  else return false;
  return true;
}
