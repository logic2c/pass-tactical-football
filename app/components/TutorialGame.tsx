"use client";

import { useEffect, useMemo, useState } from "react";
import type { ActionMode, ActionCard, GameState, Suit } from "@/shared/types";
import {
  activePlayer,
  addLog,
  autoFinishTurnIfNeeded,
  createGame,
  drawInto,
  emitEvent,
  finishPlayPhase,
  hasBall,
  playerById,
  resolveMoveAction,
  resolvePassAction,
  resolvePressAction,
} from "@/shared/game-engine";
import { GAME_BALANCE } from "@/shared/constants";
import GameBoard from "./GameBoard";

type TutorialAction = "move" | "pass" | "press" | "skip";
type TutorialFocus = "turn" | "board" | "hand" | "actions" | "feed" | "history" | "phase";

type TutorialChapter = {
  title: string;
  tag: string;
  objective: string;
  brief: string;
  lesson: string[];
  allowed: TutorialAction[];
};

const CHAPTERS: TutorialChapter[] = [
  {
    title: "界面与按键总览",
    tag: "ORIENTATION",
    objective: "完成界面总览。",
    brief: "先认识回合、棋盘、手牌和操作区，才能判断当前由谁行动、可以使用哪些操作。跟随高亮区域依次查看界面。",
    lesson: ["第 1 步：阅读当前高亮区域的说明。", "第 2 步：点击“下一个界面区域”，依次查看全部 9 个区域。", "第 3 步：点击“开始训练”。"],
    allowed: [],
  },
  {
    title: "移动球员",
    tag: "MOVE",
    objective: "将 R1 移动到 e5。",
    brief: "Rock 可以让球员横向或纵向移动最多 3 格。选择一张手牌后点击“移动”，再选择高亮目标格。",
    lesson: ["第 1 步：选择 R1 手牌中的 Rock。", "第 2 步：点击“移动”。", "第 3 步：点击 e5，将 R1 从 e3 直接移动到 e5。"],
    allowed: ["move"],
  },
  {
    title: "路线不能穿人",
    tag: "BLOCKING",
    objective: "绕开 R2，将 R1 移动到 e5。",
    brief: "e4 的 R2 挡住了 e3 到 e5 的直线。移动路线不能穿人，队友和对手都会阻挡，因此要先横向移动，再从斜线绕到目标格。",
    lesson: ["第 1 步：选择 R1 手牌中的 Rock。", "第 2 步：点击“移动”，再点击 g3，将 R1 从 e3 移动到 g3。", "第 3 步：选择 R1 手牌中的 Bishop。", "第 4 步：点击“移动”，再点击 e5，将 R1 从 g3 绕过 R2 移动到 e5。"],
    allowed: ["move"],
  },
  {
    title: "直接传给队友",
    tag: "DIRECT PASS",
    objective: "将足球传到 e6 的 R2。",
    brief: "只有持球者可以传球；把球直接传给路线上的队友，会使队友立即持球。选择持球者的手牌后点击“传球”，再选择接球队友。",
    lesson: ["第 1 步：选择 R1 手牌中的 Rock。", "第 2 步：点击“传球”。", "第 3 步：点击 e6 的 R2。"],
    allowed: ["pass"],
  },
  {
    title: "队友也会挡球",
    tag: "PASS LANE",
    objective: "通过 R2 接力，将足球传到 e7 的 R3。",
    brief: "R2 位于 R1 和 R3 之间，足球不能越过线路上首先遇到的队友。先传给 R2，再由 R2 合法地接力传给 R3。",
    lesson: ["第 1 步：选择 R1 手牌中的 Rock，点击“传球”，再点击 e5 的 R2。", "第 2 步：轮到 R2 后，选择 R2 手牌中的 Rock。", "第 3 步：点击“传球”，再点击 e7 的 R3。"],
    allowed: ["pass"],
  },
  {
    title: "行动力与手牌",
    tag: "TEMPO",
    objective: "完成一次战术整备。",
    brief: "无球队员有 2 点行动力，持球者有 1 点，行动牌通常消耗 1 点；行动力不必用完。本回合尚未行动时，可用战术整备跳过出牌并额外抽 2 张牌。",
    lesson: ["第 1 步：不要选择或使用任何手牌。", "第 2 步：点击“战术整备 · 抽 2”。", "完成后 R1 会跳过出牌阶段并额外抽取 2 张牌。"],
    allowed: ["skip"],
  },
  {
    title: "空位传球与接应",
    tag: "SPACE PASS",
    objective: "将足球传到 d8 的 R3。",
    brief: "传到空格的足球会留在场上，球员移动经过该格即可拾球，不必停下。无球队员有 2 点行动力，拾球后可以用剩余行动继续配合。",
    lesson: ["第 1 步：选择 R1 的 Rock，点击“传球”，再点击空格 e5。", "第 2 步：轮到 R2 后，选择 Bishop，点击“移动”，再点击 d6；R2 会在途中经过 e5 并拾球。", "第 3 步：选择 R2 的 Rock，点击“传球”，再点击 d8 的 R3。"],
    allowed: ["move", "pass"],
  },
  {
    title: "基础上抢",
    tag: "PRESS",
    objective: "让 B1 夺得足球。",
    brief: "只有防守方能对一格内的持球者上抢。上抢会弃置一张自己的非足球牌并随机抽取目标手牌；本关 R1 只有足球，因此一次上抢就能夺得球权。",
    lesson: ["第 1 步：选择 B1 手牌中的 Bishop。", "第 2 步：点击“上抢”。", "第 3 步：点击 d3 的 R1，夺得足球。"],
    allowed: ["press"],
  },
  {
    title: "禁区与射门",
    tag: "FINISHING",
    objective: "将足球射入蓝方球门 E。",
    brief: "球员不能进入球门，身处对方禁区时不能射门。R1 位于禁区外，但 cX 的 B1 已封锁球门 D 的线路，因此要选择畅通的 Bishop 斜线射向球门 E。",
    lesson: ["第 1 步：选择 R1 手牌中的 Bishop。", "第 2 步：点击“传球”。", "第 3 步：点击蓝方球门 E 完成射门。"],
    allowed: ["pass"],
  },
  {
    title: "完整进攻演练",
    tag: "FINAL DRILL",
    objective: "将足球射入蓝方球门 D。",
    brief: "把球直接传给更接近球门的队友，可以安全转移球权并创造射门路线。直接接球者下回合只有 1 点行动力，要把这次行动用于最后一传或射门。",
    lesson: ["第 1 步：选择 R1 的 Rock，点击“传球”，再点击 d8 的 R2。", "第 2 步：轮到 R2 后，选择 Rock，点击“传球”，再点击蓝方球门 D。"],
    allowed: ["pass"],
  },
];

const OVERVIEW: Array<{ focus: TutorialFocus; title: string; body: string }> = [
  { focus: "turn", title: "回合顺序", body: "顶部从左到右显示行动顺序。发亮的球员是当前行动者；点击自己控制的球员可以查看他的手牌。" },
  { focus: "board", title: "球员与棋盘", body: "点击棋子查看球员，点击绿色高亮格确认移动或传球。黄色外圈表示当前行动者，足球标记表示公开持球者。" },
  { focus: "hand", title: "选择手牌", body: "点击一张牌将其选中，再次点击可取消。卡牌右上角的数字是行动力费用。" },
  { focus: "actions", title: "移动与传球", body: "选牌后点击 MOVE 或 PASS，再点击棋盘上的合法目标。没有足球时不会显示 PASS。" },
  { focus: "actions", title: "上抢", body: "防守方靠近持球者后，先选择要弃置的牌，再点击“上抢”和目标球员。" },
  { focus: "actions", title: "整备与结束", body: "尚未行动时可用“战术整备”跳过出牌并抽2张；“结束回合”会立即进入弃牌阶段。" },
  { focus: "phase", title: "行动力", body: "右侧会显示剩余行动力。无球队员通常有2点，持球者只有1点；行动力不需要强行用完。" },
  { focus: "feed", title: "最近行动", body: "棋盘上方会直接说明刚才谁做了什么、球权是否变化，无需每次翻阅完整记录。" },
  { focus: "history", title: "事件与 F1", body: "事件栏用于回看细节。Windows 单机版中随时按 F1 都可以重新打开教程。" },
];

function actionCard(id: string, suit: Suit): ActionCard {
  return { id, kind: "action", suit, cost: 1 };
}

function setBall(game: GameState, playerId: string) {
  game.players.forEach((player) => {
    player.hand = player.hand.filter((card) => card.kind !== "ball");
  });
  playerById(game, playerId).hand.push({ id: "football", kind: "ball" });
  game.offense = playerById(game, playerId).team;
  game.looseBall = undefined;
}

function forceTurn(game: GameState, playerId: string, actions: number) {
  const order = ["r1", "b1", "r2", "b2", "r3", "b3"];
  game.turnIndex = order.indexOf(playerId);
  game.phase = "turn";
  game.turn = { actionsRemaining: actions, actionsSpent: 0, tackleUsed: false, acquiredBall: false, cardsPlayed: 0, longPassReady: false };
  game.discardQueue = [];
  game.discardResume = undefined;
}

function createTutorialState(chapter: number): GameState {
  const game = createGame("3v3", () => 0.5);
  const positions: Record<string, number> = { r1: 60, b1: 4, r2: 68, b2: 12, r3: 69, b3: 20 };
  game.players.forEach((player) => {
    player.position = positions[player.id];
    player.hand = [];
    player.nextTurnPenalty = 0;
  });
  game.deck = Array.from({ length: 18 }, (_, index) => actionCard(`tutorial-deck-${index}`, (['rock', 'bishop', 'knight'] as Suit[])[index % 3]));
  game.discard = [];
  game.scores = { red: 0, blue: 0 };
  game.log = ["训练局面已准备完成。"];
  game.traces = [];
  game.traceSeq = 0;
  game.eventSeq = 0;
  game.lastEvent = undefined;
  game.pendingPass = undefined;
  game.kickoffReason = "教程训练";
  forceTurn(game, "r1", 2);

  if (chapter === 0) {
    playerById(game, "r1").hand = [actionCard("overview-rock", "rock")];
    setBall(game, "r1");
  } else if (chapter === 1) {
    playerById(game, "r1").hand = [actionCard("move-rock", "rock")];
    setBall(game, "r2");
  } else if (chapter === 2) {
    playerById(game, "r2").position = 52;
    playerById(game, "r1").hand = [actionCard("block-rock", "rock"), actionCard("escape-bishop", "bishop")];
    setBall(game, "r2");
  } else if (chapter === 3) {
    playerById(game, "r2").position = 36;
    playerById(game, "r1").hand = [actionCard("direct-rock", "rock")];
    setBall(game, "r1");
    forceTurn(game, "r1", 1);
  } else if (chapter === 4) {
    playerById(game, "r2").position = 44;
    playerById(game, "r3").position = 28;
    playerById(game, "r1").hand = [actionCard("lane-rock", "rock")];
    playerById(game, "r2").hand = [actionCard("relay-rock", "rock")];
    setBall(game, "r1");
    forceTurn(game, "r1", 1);
  } else if (chapter === 5) {
    playerById(game, "r1").hand = [actionCard("tempo-rock", "rock"), actionCard("tempo-bishop", "bishop"), actionCard("tempo-knight", "knight")];
    setBall(game, "r2");
  } else if (chapter === 6) {
    playerById(game, "r2").position = 53;
    playerById(game, "r3").position = 19;
    playerById(game, "b1").position = 45;
    playerById(game, "r1").hand = [actionCard("space-pass-rock", "rock")];
    playerById(game, "r2").hand = [actionCard("pickup-bishop", "bishop"), actionCard("follow-rock", "rock")];
    setBall(game, "r1");
    forceTurn(game, "r1", 1);
  } else if (chapter === 7) {
    playerById(game, "r1").position = 59;
    playerById(game, "b1").position = 51;
    playerById(game, "b1").hand = [actionCard("press-one", "bishop")];
    setBall(game, "r1");
    forceTurn(game, "b1", 1);
  } else if (chapter === 8) {
    playerById(game, "r1").position = 10;
    playerById(game, "b1").position = 2;
    playerById(game, "r1").hand = [actionCard("goal-bishop", "bishop")];
    setBall(game, "r1");
    forceTurn(game, "r1", 1);
  } else if (chapter === 9) {
    playerById(game, "r1").position = 43;
    playerById(game, "r2").position = 19;
    playerById(game, "r3").position = 52;
    playerById(game, "b1").position = 14;
    playerById(game, "b2").position = 22;
    playerById(game, "b3").position = 30;
    playerById(game, "r1").hand = [actionCard("final-pass", "rock")];
    playerById(game, "r2").hand = [actionCard("final-shot", "rock")];
    setBall(game, "r1");
    forceTurn(game, "r1", 1);
  }
  return game;
}

function allowed(chapter: number, action: TutorialAction) {
  return CHAPTERS[chapter].allowed.includes(action);
}

export default function TutorialGame() {
  const [chapter, setChapter] = useState(0);
  const [game, setGame] = useState<GameState>(() => createTutorialState(0));
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<ActionMode>(null);
  const [overviewStep, setOverviewStep] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [showHint, setShowHint] = useState(false);
  const [unlocked, setUnlocked] = useState(() => {
    if (typeof window === "undefined") return 0;
    try {
      const saved = Number(localStorage.getItem("pass-tutorial-unlocked") || 0);
      return Number.isFinite(saved) ? Math.max(0, Math.min(CHAPTERS.length - 1, saved)) : 0;
    } catch { return 0; }
  });

  const humanTeam = chapter === 7 ? "blue" : "red";
  const humanPlayerIds = useMemo(() => game.players.filter((player) => player.team === humanTeam).map((player) => player.id), [game.players, humanTeam]);
  const humanPlayerId = humanPlayerIds[0];
  const current = activePlayer(game);
  const selectedCard = current.hand.find((card) => card.id === selectedCardId && card.kind !== "ball");
  const overview = OVERVIEW[overviewStep];

  function clearSelection() {
    setSelectedCardId(null);
    setActionMode(null);
  }

  function resetChapter(nextChapter = chapter) {
    setChapter(nextChapter);
    setGame(createTutorialState(nextChapter));
    setSelectedCardId(null);
    setActionMode(null);
    setOverviewStep(0);
    setCompleted(false);
    setFeedback("");
    setShowHint(false);
  }

  function markComplete(message: string) {
    setCompleted(true);
    setShowHint(false);
    setFeedback(message);
    const nextUnlocked = Math.max(unlocked, Math.min(CHAPTERS.length - 1, chapter + 1));
    setUnlocked(nextUnlocked);
    try { localStorage.setItem("pass-tutorial-unlocked", String(nextUnlocked)); } catch { /* local progress is optional */ }
  }

  /* The objective checker deliberately converts game-engine state into tutorial UI state. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (completed || chapter === 0) return;
    if (chapter === 1 && playerById(game, "r1").position === 44 && game.discard.some((card) => card.kind === "action" && card.suit === "rock")) {
      markComplete("完成：R1 使用 Rock 沿纵向从 e3 直接移动到 e5。 ");
    } else if (chapter === 2 && playerById(game, "r1").position === 44) {
      markComplete("完成：R1 绕开了 e4 的 R2，并成功移动到 e5。 ");
    } else if (chapter === 3 && hasBall(playerById(game, "r2"))) {
      markComplete("完成：R2 直接接到足球。直接接球很安全，但他下回合将以持球者的1点行动力开始。 ");
    } else if (chapter === 4 && hasBall(playerById(game, "r3"))) {
      markComplete("完成：足球没有越过线路中的 R2，而是通过两次合法传球接力到达 R3。 ");
    } else if (chapter === 5 && game.lastEvent?.kind === "skip-draw") {
      markComplete("完成：保存手牌并整备，有时比强行用完2点行动力更有价值。 ");
    } else if (chapter === 6 && hasBall(playerById(game, "r3"))) {
      markComplete("完成：R2 用第一点行动力拾球，再用剩余行动力传球。你已经完成一次高收益空位配合。 ");
    } else if (chapter === 7 && hasBall(playerById(game, "b1"))) {
      markComplete("完成：R1 只有足球手牌，B1 一次上抢就成功夺回球权。 ");
    } else if (chapter === 8 && game.scores.red > 0) {
      markComplete("完成：你避开被封锁的球门 D 线路，沿畅通的斜线射入球门 E。 ");
    } else if (chapter === 9 && game.scores.red > 0) {
      markComplete("全部训练完成：你已经完成跑位、接应、传球与射门的完整进攻。 ");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, chapter, completed]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function reject(action: TutorialAction) {
    setFeedback(`本关暂时不需要${action === "move" ? "移动" : action === "pass" ? "传球" : action === "press" ? "上抢" : "战术整备"}，先完成当前训练目标。`);
  }

  function handleCellClick(position: number) {
    if (completed || chapter === 0) return;
    if (!selectedCard || selectedCard.kind !== "action") {
      setFeedback("先从手牌中选择一张行动卡。 ");
      return;
    }
    if (actionMode === "move") {
      if (!allowed(chapter, "move")) return reject("move");
      if (chapter === 1) {
        if (selectedCard.id === "move-rock" && position !== 44) {
          setFeedback("这一关的目标格是 e5。请选择 R1 的 Rock，点击“移动”，再点击 e5。 ");
          return;
        }
      }
      if (chapter === 2) {
        const expectedTarget = selectedCard.id === "block-rock" ? 62 : selectedCard.id === "escape-bishop" ? 44 : undefined;
        if (selectedCard.id === "escape-bishop" && playerById(game, "r1").position !== 62) {
          setFeedback("先使用 Rock 将 R1 从 e3 横向移动到 g3，再用 Bishop 绕到 e5。 ");
          return;
        }
        if (expectedTarget !== undefined && position !== expectedTarget) {
          setFeedback(`这一步的目标格是 ${selectedCard.id === "block-rock" ? "g3" : "e5"}。请点击该格。`);
          return;
        }
      }
      if (chapter === 6 && selectedCard.id === "pickup-bishop" && position !== 35) {
        setFeedback("这一步的指定目标是 d6。R2 会在移动途中经过 e5 并拾球。 ");
        return;
      }
      setGame((previous) => {
        const next = structuredClone(previous);
        if (!resolveMoveAction(next, selectedCard.id, position)) {
          setFeedback("这个移动不合法。检查距离以及路径上是否有球员阻挡。 ");
          return previous;
        }
        autoFinishTurnIfNeeded(next);
        return next;
      });
    } else if (actionMode === "pass") {
      if (!allowed(chapter, "pass")) return reject("pass");
      if (chapter === 3 && selectedCard.id === "direct-rock" && position !== 36) {
        setFeedback("本关目标是 e6 的 R2。请点击 e6。 ");
        return;
      }
      if (chapter === 4) {
        const expectedTarget = selectedCard.id === "lane-rock" ? 44 : selectedCard.id === "relay-rock" ? 28 : undefined;
        if (expectedTarget !== undefined && position !== expectedTarget) {
          setFeedback(`这一步的目标是 ${selectedCard.id === "lane-rock" ? "e5 的 R2" : "e7 的 R3"}。请点击该球员。`);
          return;
        }
      }
      if (chapter === 6) {
        const expectedTarget = selectedCard.id === "space-pass-rock" ? 44 : selectedCard.id === "follow-rock" ? 19 : undefined;
        if (expectedTarget !== undefined && position !== expectedTarget) {
          setFeedback(`这一步的指定目标是 ${selectedCard.id === "space-pass-rock" ? "空格 e5" : "d8 的 R3"}。请点击该格。`);
          return;
        }
      }
      if (chapter === 8) {
        if (selectedCard.id === "goal-bishop" && position !== 81) {
          setFeedback("球门 D 的线路已被 B1 封锁。请选择 Bishop，点击“传球”，再点击畅通的球门 E。 ");
          return;
        }
      }
      if (chapter === 9) {
        const expectedTarget = selectedCard.id === "final-pass" ? 19 : selectedCard.id === "final-shot" ? 80 : undefined;
        if (expectedTarget !== undefined && position !== expectedTarget) {
          setFeedback(`这一步的指定目标是 ${selectedCard.id === "final-pass" ? "d8 的 R2" : "蓝方球门 D"}。请点击该位置。`);
          return;
        }
      }
      setGame((previous) => {
        const next = structuredClone(previous);
        if (!resolvePassAction(next, selectedCard.id, position, humanPlayerIds)) {
          setFeedback("这条传球线路不合法，可能被球员阻挡或超出距离。 ");
          return previous;
        }
        if (chapter === 4 && selectedCard.id === "lane-rock" && hasBall(playerById(next, "r2"))) {
          forceTurn(next, "r2", 1);
          setFeedback("R2 已接到足球。现在选择 R2 的 Rock，点击“传球”，再点击 e7 的 R3。 ");
        } else if (chapter === 6 && next.looseBall === 44) {
          forceTurn(next, "r2", 2);
          setFeedback("R2 以无球状态开始回合，拥有2点行动力。现在用 Bishop 移动经过足球格。 ");
        } else if (chapter === 9 && hasBall(playerById(next, "r2"))) {
          forceTurn(next, "r2", 1);
          setFeedback("R2 已直接接球，因此以持球者的1点行动力开始。选择 Rock 射向左侧球门。 ");
        }
        return next;
      });
    } else {
      setFeedback("选牌后还需要点击“移动”或“传球”。 ");
      return;
    }
    clearSelection();
  }

  function performPress(targetId: string) {
    if (!allowed(chapter, "press")) return reject("press");
    if (!selectedCard) return setFeedback("先选择一张要弃置的手牌。 ");
    if (chapter === 7) {
      if (targetId !== "r1") return setFeedback("本关的上抢目标是 d3 的 R1。请点击 R1。 ");
      if (selectedCard.id !== "press-one") return setFeedback("请选择 B1 的 Bishop，再对 d3 的 R1 使用上抢。 ");
    }
    setGame((previous) => {
      const next = structuredClone(previous);
      if (!resolvePressAction(next, selectedCard.id, targetId, () => 0)) {
        setFeedback("上抢需要目标持球，并且双方距离在一格以内。 ");
        return previous;
      }
      autoFinishTurnIfNeeded(next);
      return next;
    });
    clearSelection();
  }

  function skipPlayAndDraw() {
    if (!allowed(chapter, "skip")) return reject("skip");
    setGame((previous) => {
      const next = structuredClone(previous);
      const player = activePlayer(next);
      drawInto(next, player, GAME_BALANCE.skipPlayDraw, () => 0.5);
      addLog(next, `${player.label} 跳过出牌阶段，额外抽取 ${GAME_BALANCE.skipPlayDraw} 张牌。`);
      emitEvent(next, { kind: "skip-draw", actorId: player.id, label: `${player.label} 选择战术整备`, result: `跳过出牌并额外抽取 ${GAME_BALANCE.skipPlayDraw} 张牌。`, tone: "neutral" });
      finishPlayPhase(next);
      return next;
    });
    clearSelection();
  }

  function endTurn() {
    setFeedback("本关不需要主动结束回合。请按照训练目标完成操作。 ");
  }

  function nextOverview() {
    if (overviewStep < OVERVIEW.length - 1) {
      setOverviewStep((value) => value + 1);
      return;
    }
    markComplete("界面总览完成。接下来开始实际操作训练。 ");
  }

  function nextChapter() {
    if (chapter >= CHAPTERS.length - 1) {
      resetChapter(0);
      return;
    }
    resetChapter(chapter + 1);
  }

  function exitTutorial() {
    if (window.location.protocol === "file:") {
      window.close();
      return;
    }
    const url = new URL(window.location.href);
    url.search = "";
    window.location.href = url.toString();
  }

  const wrapperClass = chapter === 0 ? `tutorial-wrapper overview tutorial-focus-${overview.focus}` : "tutorial-wrapper";
  const chapterCopy = CHAPTERS[chapter];

  return (
    <div className={wrapperClass}>
      <GameBoard
        game={game}
        humanPlayerId={humanPlayerId}
        humanPlayerIds={humanPlayerIds}
        selectedCardId={selectedCardId}
        setSelectedCardId={(id) => { setSelectedCardId(id); setActionMode(null); setFeedback(""); }}
        actionMode={actionMode}
        setActionMode={(mode) => { setActionMode(mode); setFeedback(""); }}
        setupPlayerId={humanPlayerId}
        setSetupPlayerId={() => {}}
        saveDiscardIds={[]}
        toggleSaveDiscard={() => {}}
        onCellClick={(position) => {
          if (chapter === 7 && actionMode === "press") {
            const target = game.players.find((player) => player.position === position);
            if (target) performPress(target.id);
            return;
          }
          handleCellClick(position);
        }}
        onChooseHumanPlayer={() => {}}
        onStartKickoff={() => {}}
        onResetPositions={() => resetChapter()}
        onSkipPlayAndDraw={skipPlayAndDraw}
        onEndPlayPhase={endTurn}
        onPerformImmediateSpecial={() => {}}
        onDeclineSave={() => {}}
        onDiscardOverflow={() => {}}
        onRestartGame={() => resetChapter()}
      />

      <aside className={`tutorial-coach ${completed ? "complete" : ""}`} aria-live="polite">
        <div className="tutorial-coach-head">
          <div><span>{chapterCopy.tag}</span><strong>{chapter === 0 ? "准备" : `训练 ${String(chapter).padStart(2, "0")}`} / {CHAPTERS.length - 1}</strong></div>
          <button onClick={exitTutorial} aria-label="退出教程">×</button>
        </div>
        <div className="tutorial-progress" aria-label="教程进度">
          {CHAPTERS.map((item, index) => <button key={item.tag} disabled={index > unlocked} className={`${index === chapter ? "active" : ""} ${index < chapter || index <= unlocked ? "unlocked" : ""}`} title={item.title} onClick={() => index <= unlocked && resetChapter(index)}>{index}</button>)}
        </div>
        <p className="tutorial-kicker">{chapter === 0 ? `${overviewStep + 1} / ${OVERVIEW.length} · ${overview.title}` : chapterCopy.title}</p>
        <h2>{chapter === 0 ? overview.title : chapterCopy.objective}</h2>
        <p className="tutorial-body">{chapter === 0 ? overview.body : <><strong>本关规则：</strong>{chapterCopy.brief}</>}</p>
        {feedback && <p className={`tutorial-feedback ${completed ? "success" : ""}`}>{feedback}</p>}
        {chapter !== 0 && !completed && showHint && <div id="tutorial-detailed-hint" className="tutorial-hint"><strong>详细步骤</strong>{chapterCopy.lesson.map((line) => <p key={line}>{line}</p>)}</div>}
        <div className="tutorial-coach-actions">
          {!completed && chapter === 0 && <button className="primary-action" onClick={nextOverview}>{overviewStep === OVERVIEW.length - 1 ? "开始训练" : "下一个界面区域"}</button>}
          {!completed && chapter !== 0 && <button className="secondary-action" aria-expanded={showHint} aria-controls="tutorial-detailed-hint" onClick={() => setShowHint((value) => !value)}>{showHint ? "收起提示" : "需要提示"}</button>}
          {!completed && chapter !== 0 && <button className="quiet-button" onClick={() => resetChapter()}>重置本关</button>}
          {completed && <button className="primary-action" onClick={nextChapter}>{chapter === CHAPTERS.length - 1 ? "重新查看教程" : "下一关"}</button>}
        </div>
      </aside>
    </div>
  );
}
