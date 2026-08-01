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
  lesson: string[];
  allowed: TutorialAction[];
};

const CHAPTERS: TutorialChapter[] = [
  {
    title: "界面与按键总览",
    tag: "ORIENTATION",
    objective: "依次认识比赛界面的主要区域和操作方式。",
    lesson: ["这一部分不会推进比赛。", "跟随高亮区域阅读说明，然后开始训练。"],
    allowed: [],
  },
  {
    title: "移动球员",
    tag: "MOVE",
    objective: "将 R1 移动到 e5。",
    lesson: ["第 1 步：选择手牌 Rock。", "第 2 步：点击“移动”，再点击 g3，将 R1 从 e3 移到 g3。", "第 3 步：选择手牌 Bishop。", "第 4 步：点击“移动”，再点击 e5，将 R1 从 g3 移到 e5。"],
    allowed: ["move"],
  },
  {
    title: "路线不能穿人",
    tag: "BLOCKING",
    objective: "将 R1 移动到 d4。",
    lesson: ["第 1 步：选择手牌 Rock。", "第 2 步：点击“移动”，再点击 e5；位于 e4 的 R2 会阻挡这条路线。", "第 3 步：选择手牌 Bishop。", "第 4 步：点击“移动”，再点击 d4，绕开队友完成本关。"],
    allowed: ["move"],
  },
  {
    title: "直接传给队友",
    tag: "DIRECT PASS",
    objective: "使用 Rock 将 R1 的足球直接传给 R2。",
    lesson: ["选择行动卡后点击“传球”。", "合法队友和落点会在棋盘上高亮。"],
    allowed: ["pass"],
  },
  {
    title: "队友也会挡球",
    tag: "PASS LANE",
    objective: "先尝试越过 R2 传给 R3，再把球交给最先挡路的 R2。",
    lesson: ["传球不能越过第一个挡路的球员。", "第一个挡路的是队友时，可以直接传给他。"],
    allowed: ["pass"],
  },
  {
    title: "行动力与手牌",
    tag: "TEMPO",
    objective: "本回合不要出牌，点击“战术整备”补充手牌。",
    lesson: ["无球队员准备阶段获得2点行动力，持球者只有1点。", "直接接球会让队友下回合以持球者身份开始；行动力上限并不意味着必须把牌用完。"],
    allowed: ["skip"],
  },
  {
    title: "空位传球与接应",
    tag: "SPACE PASS",
    objective: "将球传到空格，让 R2 移动经过足球后，再把球传给 R3。",
    lesson: ["R2 开始回合时仍然无球，因此获得2点行动力。", "第一点行动力移动拾球后不会重置，仍可用第二点行动力继续移动或传球。", "空位传球收益很高，但对手也可能先到达落点。"],
    allowed: ["move", "pass"],
  },
  {
    title: "基础上抢",
    tag: "PRESS",
    objective: "使用 B1 连续上抢 R1，观察一次失败和一次成功。",
    lesson: ["上抢需要在持球者一格以内，消耗1点行动力并弃置一张牌。", "第一次会削减对方手牌，第二次固定抽中足球。"],
    allowed: ["press"],
  },
  {
    title: "禁区与射门",
    tag: "FINISHING",
    objective: "先尝试被 B1 封锁的左侧球门，再改用 Bishop 射入另一侧球门。",
    lesson: ["球员不能移动进入球门，必须使用 PASS 射门。", "射门仍会被球员阻挡；身处对方禁区时不能射门。"],
    allowed: ["pass"],
  },
  {
    title: "完整进攻演练",
    tag: "FINAL DRILL",
    objective: "让 R1 把球交给 R2，再由 R2 完成射门。",
    lesson: ["现在不再逐步锁定选择。", "观察行动顺序、传球路线和剩余手牌，完成一次完整进攻。"],
    allowed: ["move", "pass"],
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
    playerById(game, "r1").hand = [actionCard("move-rock", "rock"), actionCard("move-bishop", "bishop")];
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
    playerById(game, "r1").hand = [actionCard("target-rock", "rock")];
    playerById(game, "b1").hand = [actionCard("press-one", "bishop"), actionCard("press-two", "rock")];
    setBall(game, "r1");
    forceTurn(game, "b1", 2);
  } else if (chapter === 8) {
    playerById(game, "r1").position = 10;
    playerById(game, "b1").position = 2;
    playerById(game, "r1").hand = [actionCard("blocked-knight", "knight"), actionCard("goal-bishop", "bishop")];
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
  const [attemptedBlock, setAttemptedBlock] = useState(false);
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
    setAttemptedBlock(false);
    setCompleted(false);
    setFeedback("");
    setShowHint(false);
  }

  function markComplete(message: string) {
    setCompleted(true);
    setFeedback(message);
    const nextUnlocked = Math.max(unlocked, Math.min(CHAPTERS.length - 1, chapter + 1));
    setUnlocked(nextUnlocked);
    try { localStorage.setItem("pass-tutorial-unlocked", String(nextUnlocked)); } catch { /* local progress is optional */ }
  }

  /* The objective checker deliberately converts game-engine state into tutorial UI state. */
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (completed || chapter === 0) return;
    if (chapter === 1 && game.discard.some((card) => card.kind === "action" && card.suit === "rock") && game.discard.some((card) => card.kind === "action" && card.suit === "bishop")) {
      markComplete("完成：你已经分别使用了横纵和斜向移动。 ");
    } else if (chapter === 2 && attemptedBlock && playerById(game, "r1").position === 51) {
      markComplete("完成：直线被占据时，换用斜向路线成功脱离。 ");
    } else if (chapter === 3 && hasBall(playerById(game, "r2"))) {
      markComplete("完成：R2 直接接到足球。直接接球很安全，但他下回合将以持球者的1点行动力开始。 ");
    } else if (chapter === 4 && attemptedBlock && hasBall(playerById(game, "r2"))) {
      markComplete("完成：R2 是线路上的第一名队友，因此足球只能先交给他。 ");
    } else if (chapter === 5 && game.lastEvent?.kind === "skip-draw") {
      markComplete("完成：保存手牌并整备，有时比强行用完2点行动力更有价值。 ");
    } else if (chapter === 6 && hasBall(playerById(game, "r3"))) {
      markComplete("完成：R2 用第一点行动力拾球，再用剩余行动力传球。你已经完成一次高收益空位配合。 ");
    } else if (chapter === 7 && hasBall(playerById(game, "b1"))) {
      markComplete("完成：第一次上抢削减了手牌，第二次抽中足球并夺回球权。 ");
    } else if (chapter === 8 && attemptedBlock && game.scores.red > 0) {
      markComplete("完成：一侧射门被封锁后，你改走另一条几何线路取得进球。 ");
    } else if (chapter === 9 && game.scores.red > 0) {
      markComplete("全部训练完成：你已经完成跑位、接应、传球与射门的完整进攻。 ");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, attemptedBlock, chapter, completed]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function reject(action: TutorialAction) {
    setFeedback(`本关暂时不需要${action === "move" ? "移动" : action === "pass" ? "传球" : action === "press" ? "上抢" : "战术整备"}，先完成当前训练目标。`);
  }

  function handleCellClick(position: number) {
    if (completed || chapter === 0) return;
    if (chapter === 2 && actionMode === "move" && selectedCard?.id === "block-rock") {
      if (position !== 44) {
        setFeedback("本关第一步的指定目标是 e5。请选择 Rock，点击“移动”，再点击 e5。 ");
        return;
      }
      setAttemptedBlock(true);
      setFeedback("Rock 的 e3 → e5 路线被位于 e4 的 R2 阻挡。现在请选择 Bishop，点击“移动”，再点击 d4。 ");
      return;
    }
    if (chapter === 2 && actionMode === "move" && selectedCard?.id === "escape-bishop") {
      if (!attemptedBlock) {
        setFeedback("请先完成第一步：使用 Rock 尝试从 e3 移到 e5。 ");
        return;
      }
      if (position !== 51) {
        setFeedback("第二步的指定目标是 d4。请选择 Bishop，点击“移动”，再点击 d4。 ");
        return;
      }
    }
    if (chapter === 4 && actionMode === "pass" && position === 28) {
      setAttemptedBlock(true);
      setFeedback("R2 是线路上的第一名球员，足球不能越过他传给 R3。请改为直接点击 R2。 ");
      return;
    }
    if (chapter === 8 && actionMode === "pass" && position === 80) {
      setAttemptedBlock(true);
      setFeedback("左侧球门的 Knight 路线被 B1 封锁。换用 Bishop，观察另一侧球门。 ");
      return;
    }
    if (!selectedCard || selectedCard.kind !== "action") {
      setFeedback("先从手牌中选择一张行动卡。 ");
      return;
    }
    if (actionMode === "move") {
      if (!allowed(chapter, "move")) return reject("move");
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
      setGame((previous) => {
        const next = structuredClone(previous);
        if (!resolvePassAction(next, selectedCard.id, position, humanPlayerIds)) {
          setFeedback("这条传球线路不合法，可能被球员阻挡或超出距离。 ");
          return previous;
        }
        if (chapter === 6 && next.looseBall === 44) {
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
        <p className="tutorial-body">{chapter === 0 ? overview.body : chapterCopy.lesson[0]}</p>
        {chapter !== 0 && chapterCopy.lesson.slice(1).map((line) => <p className="tutorial-note" key={line}>{line}</p>)}
        {feedback && <p className={`tutorial-feedback ${completed ? "success" : ""}`}>{feedback}</p>}
        {chapter !== 0 && showHint && <p className="tutorial-hint">提示：{chapterCopy.objective}</p>}
        <div className="tutorial-coach-actions">
          {!completed && chapter === 0 && <button className="primary-action" onClick={nextOverview}>{overviewStep === OVERVIEW.length - 1 ? "开始训练" : "下一个界面区域"}</button>}
          {!completed && chapter !== 0 && <button className="secondary-action" onClick={() => setShowHint((value) => !value)}>{showHint ? "收起提示" : "需要提示"}</button>}
          {!completed && chapter !== 0 && <button className="quiet-button" onClick={() => resetChapter()}>重置本关</button>}
          {completed && <button className="primary-action" onClick={nextChapter}>{chapter === CHAPTERS.length - 1 ? "重新查看教程" : "下一关"}</button>}
        </div>
      </aside>
    </div>
  );
}
