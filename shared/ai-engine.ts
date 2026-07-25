import type { AiTurnPlan, GameState } from "./types";
import { AI_TUNING, GAME_BALANCE, SUIT_INFO } from "./constants";
import { weightedAiChoice } from "./ai";
import type { AiCandidate } from "./ai";
import { enemyGoal, movementPath } from "./game-rules";
import {
  actionCards,
  activePlayer,
  addLog,
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
    const moveChoice = weightedAiChoice(movePlans, AI_TUNING.detailTemperature, random);
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
      const pressChoice = weightedAiChoice(pressPlans, AI_TUNING.detailTemperature, random);
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
        const tackleChoice = weightedAiChoice(tacklePlans, AI_TUNING.detailTemperature, random);
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
      const kickChoice = weightedAiChoice(kickPlans, AI_TUNING.detailTemperature, random);
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
    const passChoice = weightedAiChoice(passPlans, AI_TUNING.detailTemperature, random);
    if (passChoice) choices.push({ value: passChoice.value, score: passChoice.score, reason: passChoice.reason });
  }

  const selection = weightedAiChoice(choices, AI_TUNING.turnTemperature, random);
  if (!selection) return finishPlayPhase(game);
  const labels: Record<string, string> = { "skip-draw": "蓄力抽牌", end: "结束出牌", move: "移动", tackle: "使用抢断卡", press: "近身上抢", pass: "落点传球", sprint: "冲刺", supply: "补给", "long-pass": "准备长传", "save-recycle": "更换扑救", "flying-kick": "飞踢" };
  logAiSelection(game, player, selection, labels[selection.value.kind] ?? selection.value.kind);
  const plan = selection.value;
  if (plan.kind === "skip-draw") {
    drawInto(game, player, GAME_BALANCE.skipPlayDraw, random);
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
    if (!resolveTackleAction(game, plan.cardId, plan.targetId, random)) finishPlayPhase(game);
  } else if (plan.kind === "press") {
    if (!resolvePressAction(game, plan.targetId, random)) finishPlayPhase(game);
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
  } else if (!resolvePassAction(game, plan.cardId, plan.position, humanPlayerIds[0])) {
    finishPlayPhase(game);
  }
}

export function runAiSaveResponse(game: GameState, _random = Math.random) {
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
  else if (game.phase === "save-response") runAiSaveResponse(game, random);
  else if (game.phase === "discard") runAiDiscard(game, random);
  else return false;
  return true;
}
