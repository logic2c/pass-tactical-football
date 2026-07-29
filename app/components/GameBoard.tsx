"use client";

import { type CSSProperties, useState } from "react";
import {
  ALL_GOALS,
  BOARD_HEIGHT,
  BOARD_SIZE,
  BOARD_WIDTH,
  BLUE_GOALS,
  BLUE_PENALTY_AREA,
  RED_PENALTY_AREA,
  positionCoordinate,
} from "@/shared/game-rules";
import type {
  ActionMode,
  GameState,
  PlayCard,
  Team,
} from "@/shared/types";
import {
  FILES,
  GAME_BALANCE,
  SPECIAL_INFO,
  SUIT_INFO,
  describeTeam,
} from "@/shared/constants";
import {
  activePlayer,
  canAct,
  countedHandSize,
  exactStepPaths,
  getTurnOrderForGame,
  hasBall,
  handLimit,
  isAdjacent,
  isStepAdjacent,
  legalPassTargets,
  movementTargets,
  playerById,
  saveExtraCards,
  specialCards,
  squareName,
} from "@/shared/game-engine";
import { phaseActorId } from "@/shared/ai-engine";

const WINNING_SCORE = GAME_BALANCE.winningScore;
const SKIP_PLAY_DRAW = GAME_BALANCE.skipPlayDraw;

function KnightRouteIcon() {
  return <svg className="knight-route-icon" viewBox="0 0 72 72" aria-label="先向上，再向右上斜走的日字路线" role="img">
    <circle cx="17" cy="58" r="4" />
    <path className="route" d="M17 58 V35 L52 14" />
    <path className="arrow" d="M40 14 H52 L48 25" />
  </svg>;
}

function SuitIcon({ suit }: { suit: "rock" | "bishop" | "knight" }) {
  return suit === "knight" ? <KnightRouteIcon /> : <>{SUIT_INFO[suit].icon}</>;
}

export interface GameBoardProps {
  game: GameState;
  humanPlayerId: string;
  humanPlayerIds?: string[];
  selectedCardId: string | null;
  setSelectedCardId: (id: string | null) => void;
  actionMode: ActionMode;
  setActionMode: (mode: ActionMode) => void;
  setupPlayerId: string;
  setSetupPlayerId: (id: string) => void;
  saveDiscardIds: string[];
  toggleSaveDiscard: (cardId: string) => void;
  onCellClick: (position: number) => void;
  onChooseHumanPlayer: (playerId: string) => void;
  onStartKickoff: () => void;
  onResetPositions: () => void;
  onSkipPlayAndDraw: () => void;
  onEndPlayPhase: () => void;
  onPerformImmediateSpecial: () => void;
  onDeclineSave: () => void;
  onDiscardOverflow: (cardId: string) => void;
  onRestartGame: () => void;
  isMultiplayer?: boolean;
  canConfirmKickoff?: boolean;
}

export default function GameBoard({
  game,
  humanPlayerId,
  humanPlayerIds,
  selectedCardId,
  setSelectedCardId,
  actionMode,
  setActionMode,
  setupPlayerId,
  setSetupPlayerId,
  saveDiscardIds,
  toggleSaveDiscard,
  onCellClick,
  onChooseHumanPlayer,
  onStartKickoff,
  onResetPositions,
  onSkipPlayAndDraw,
  onEndPlayPhase,
  onPerformImmediateSpecial,
  onDeclineSave,
  onDiscardOverflow,
  onRestartGame,
  isMultiplayer,
  canConfirmKickoff = true,
}: GameBoardProps) {
  const controlledPlayerIds = humanPlayerIds ?? [humanPlayerId];
  const isHumanControlled = (playerId: string) => controlledPlayerIds.includes(playerId);
  const [handView, setHandView] = useState({ turnActorId: "", playerId: humanPlayerId });
  const current = activePlayer(game);
  const responsePlayer = game.phase === "save-response" && game.pendingPass?.responderId
    ? playerById(game, game.pendingPass.responderId)
    : undefined;
  const phaseFocusPlayer = game.phase === "discard" && game.discardQueue[0]
    ? playerById(game, game.discardQueue[0])
    : responsePlayer ?? current;
  const defaultViewedPlayerId = controlledPlayerIds.includes(handView.playerId)
    ? handView.playerId
    : controlledPlayerIds[0] ?? humanPlayerId;
  const mustShowPhasePlayer = (game.phase === "discard" || game.phase === "save-response") && isHumanControlled(phaseFocusPlayer.id);
  const currentHumanTurnStarted = game.phase === "turn" && isHumanControlled(current.id) && handView.turnActorId !== current.id;
  const focusPlayer = playerById(game, mustShowPhasePlayer
    ? phaseFocusPlayer.id
    : currentHumanTurnStarted ? current.id : defaultViewedPlayerId);
  const actorId = phaseActorId(game);
  const aiThinking = !isMultiplayer && Boolean(actorId && !isHumanControlled(actorId));
  const humanTurn = game.phase === "turn" && isHumanControlled(current.id);
  const humanSaveResponse = game.phase === "save-response" && Boolean(responsePlayer && isHumanControlled(responsePlayer.id));
  const focusIsHuman = isHumanControlled(focusPlayer.id);
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

  // Check if it's the human's turn in multiplayer (to disable controls)
  const isMyTurn = !isMultiplayer || Boolean(actorId && isHumanControlled(actorId));
  const controlsEnabled = !isMultiplayer || isMyTurn;
  const perspectiveTeam = playerById(game, humanPlayerId).team;
  const boardPositions = Array.from({ length: BOARD_SIZE }, (_, viewPosition) => perspectiveTeam === "blue" ? BOARD_SIZE - 1 - viewPosition : viewPosition);
  const fileLabels = perspectiveTeam === "blue" ? [...FILES].reverse() : FILES;
  const toViewCoordinate = (position: number) => {
    const coordinate = positionCoordinate(position) ?? { row: 0, col: 0 };
    return perspectiveTeam === "blue"
      ? { row: BOARD_HEIGHT - 1 - coordinate.row, col: BOARD_WIDTH - 1 - coordinate.col }
      : coordinate;
  };
  const viewPoint = (position: number) => {
    const coordinate = toViewCoordinate(position);
    return {
      x: coordinate.col * (100 / BOARD_WIDTH) + 100 / BOARD_WIDTH / 2,
      y: coordinate.row < 0 ? -2.4 : coordinate.row >= BOARD_HEIGHT ? 102.4 : coordinate.row * (100 / BOARD_HEIGHT) + 100 / BOARD_HEIGHT / 2,
    };
  };

  const eventMarker = (message: string) => {
    if (message.includes("进球") || message.includes("得分")) return { icon: "⚽", label: "进球" };
    if (message.includes("传球") || message.includes("长传")) return { icon: "⇢", label: "传球" };
    if (message.includes("移动") || message.includes("走到")) return { icon: "↗", label: "移动" };
    if (message.includes("抢断") || message.includes("上抢") || message.includes("飞踢")) return { icon: "✦", label: "对抗" };
    if (message.includes("抽") || message.includes("整备")) return { icon: "+", label: "抽牌" };
    if (message.includes("弃") || message.includes("结束")) return { icon: "■", label: "阶段" };
    return { icon: "•", label: "事件" };
  };

  const phaseCopy = (() => {
    if (game.phase === "setup") return isMultiplayer
      ? ["等待双方准备", "每位玩家控制自己的球员；房主确认后开始比赛。"]
      : ["选择球队并布阵", "你将控制己方全部球员；对方球员由 AI 控制。"];
    if (game.phase === "kickoff") return [game.kickoffReason, "调整你的球员位置后确认开球；开球者随后抽1张，并在准备阶段获得行动力。"];
    if (game.phase === "turn") {
      const restriction = hasBall(current)
        ? game.turn.acquiredBall
          ? `刚刚获得足球，仍剩 ${game.turn.actionsRemaining} 次行动。`
          : `持球者在准备阶段获得行动力，当前剩余 ${game.turn.actionsRemaining} 点。`
        : `无球队员在准备阶段获得行动力，当前剩余 ${game.turn.actionsRemaining} 点。`;
      if (isHumanControlled(current.id)) {
        return [`${current.label} · 你的出牌阶段`, `已自动抽1张。${restriction}`];
      }
      return isMultiplayer
        ? [`等待 ${current.label} 行动`, `对方正在选择操作；当前剩余 ${game.turn.actionsRemaining} 点行动力。`]
        : [`${current.label} · AI 出牌阶段`, `已自动抽 1 张未知牌；AI 正在评估剩余 ${game.turn.actionsRemaining} 次行动。`];
    }
    if (game.phase === "save-response" && responsePlayer && game.pendingPass) {
      if (isHumanControlled(responsePlayer.id)) {
        return [`${responsePlayer.label} · 扑救响应`, `选择要额外弃置的牌；弃 X 张即可移动 X 步，随后点击高亮落点。`];
      }
      return isMultiplayer
        ? [`等待 ${responsePlayer.label} 响应`, "传球尚未完成，对方正在决定是否使用扑救。"]
        : [`${responsePlayer.label} · AI 扑救响应`, `传球尚未完成，AI 正在判断能否移动到传球线路。`];
    }
    if (game.phase === "discard" && game.discardQueue[0]) {
      const player = playerById(game, game.discardQueue[0]);
      if (isHumanControlled(player.id)) {
        return [`${player.label} · 你的弃牌阶段`, `弃置行动卡或特殊卡，直到不超过 ${handLimit(game, player)} 张。`];
      }
      return isMultiplayer
        ? [`等待 ${player.label} 弃牌`, `对方正在将手牌整理至上限 ${handLimit(game, player)} 张。`]
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
          <div className="score-divider"><span>FIRST TO {WINNING_SCORE}</span><b>:</b></div>
          <div className="team-score blue-score"><strong>{game.scores.blue}</strong><span>BLUE</span></div>
        </section>
        <div className="header-actions">
          <span className={`possession ${game.offense}`}>{game.looseBall === undefined ? `${describeTeam(game.offense)}进攻` : `足球落地 · ${describeTeam(game.offense)}进攻`}</span>
          {!isMultiplayer && <button className="quiet-button" onClick={onRestartGame}>重开比赛</button>}
          {isMultiplayer && <span className="multiplayer-badge">联机模式</span>}
        </div>
      </header>

      <nav className="turn-ribbon" aria-label="回合顺序">
        <span className="turn-label">TURN ORDER</span>
        {getTurnOrderForGame(game).map((id, index) => {
          const player = playerById(game, id);
          return <div key={id} role={isHumanControlled(player.id) ? "button" : undefined} tabIndex={isHumanControlled(player.id) ? 0 : undefined} title={isHumanControlled(player.id) ? `查看 ${player.label} 手牌` : undefined} onClick={() => isHumanControlled(player.id) && setHandView({ turnActorId: current.id, playerId: player.id })} onKeyDown={(event) => { if (isHumanControlled(player.id) && (event.key === "Enter" || event.key === " ")) setHandView({ turnActorId: current.id, playerId: player.id }); }} className={`turn-chip ${player.team} ${isHumanControlled(player.id) ? "human" : isMultiplayer ? "remote-player" : "ai"} ${index === game.turnIndex ? "active" : ""}`}>
            <i>{index + 1}</i>{player.label}{hasBall(player) && <b title="公开持球者">●</b>}<small>{isHumanControlled(player.id) ? "YOU" : isMultiplayer ? "玩家" : "AI"}</small>
          </div>;
        })}
        <span className="deck-count">牌库 {game.deck.length}<i />弃牌 {game.discard.length}</span>
      </nav>

      <div className="game-layout">
        <aside className="match-log event-history" aria-label="比赛事件历史">
          <div className="panel-title-row"><h3>事件</h3><span>最新在前</span></div>
          <div className="event-track">
            {game.log.slice(0, 10).map((message, index) => {
              const marker = eventMarker(message);
              return <details className="event-node" key={`${message}-${index}`}>
                <summary aria-label={`${marker.label}：${message}`}>
                  <span className="event-symbol" aria-hidden="true">{marker.icon}</span>
                  <span className="event-index">{String(game.log.length - index).padStart(2, "0")}</span>
                </summary>
                <div className="event-popover"><strong>{marker.label}</strong><p>{message}</p></div>
              </details>;
            })}
          </div>
          <details className="full-match-history">
            <summary>查看完整记录</summary>
            <div className="full-history-scroll">{game.log.map((message, index) => <p key={`${message}-full-${index}`}><i>{String(game.log.length - index).padStart(2, "0")}</i>{message}</p>)}</div>
          </details>
        </aside>

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
              <p>{visibleEvent?.result ?? (isMultiplayer ? "双方玩家的移动、传球、上抢与球权变化会显示在这里。" : "AI 和玩家的移动、传球、上抢与球权变化会显示在这里。")}</p>
            </div>
          </section>
          <div className="pitch-frame">
            <div className={`pitch perspective-${perspectiveTeam}`} role="grid" aria-label={`8乘8足球棋盘，${describeTeam(perspectiveTeam)}视角`}>
              <div className="center-circle" aria-hidden="true" /><div className="halfway-line" aria-hidden="true" />
              <div className="trace-layer" aria-hidden="true">
                {traceSegments.map(({ trace, from, to, segment }) => {
                  const { x: fromX, y: fromY } = viewPoint(from);
                  const { x: toX, y: toY } = viewPoint(to);
                  const width = Math.hypot(toX - fromX, toY - fromY);
                  const angle = Math.atan2(toY - fromY, toX - fromX) * 180 / Math.PI;
                  const style = { left: `${fromX}%`, top: `${fromY}%`, width: `${width}%`, transform: `rotate(${angle}deg)` } as CSSProperties;
                  return <span key={`${trace.id}-${segment}`} className={`trace-line ${trace.kind} ${trace.team}`} style={style}><i /></span>;
                })}
              </div>
              {boardPositions.map((position) => {
                const player = game.players.find((item) => item.position === position);
                const penaltyArea = BLUE_PENALTY_AREA.includes(position as (typeof BLUE_PENALTY_AREA)[number]) || RED_PENALTY_AREA.includes(position as (typeof RED_PENALTY_AREA)[number]);
                const valid = validCells.has(position);
                const setupSelected = player?.id === setupPlayerId && (game.phase === "setup" || game.phase === "kickoff");
                const closeInteractionTarget = humanTurn && controlsEnabled && player && player.team !== current.team && (
                  ((actionMode === "tackle" && player.hand.length > 0) || (actionMode === "press" && Boolean(selectedCard) && hasBall(player))) && isAdjacent(current.position, player.position) ||
                  (actionMode === "flying-kick" && isStepAdjacent(current.position, player.position))
                );
                const eventFrom = visibleEvent?.from === position;
                const eventTo = visibleEvent?.to === position || visibleEvent?.ballSquare === position;
                const eventRoute = eventPath.has(position);
                return <button
                  key={position}
                  className={`pitch-cell ${(Math.floor(position / BOARD_WIDTH) + position) % 2 ? "stripe" : ""} ${penaltyArea ? "penalty-area" : ""} ${valid ? "valid" : ""} ${closeInteractionTarget ? "tackle-target" : ""} ${eventRoute ? "event-route" : ""} ${eventFrom ? "event-from" : ""} ${eventTo ? "event-to" : ""}`}
                  onClick={() => onCellClick(position)}
                  aria-label={`${squareName(position)}${player ? `，${player.label}` : ""}${game.looseBall === position ? "，足球落点" : ""}`}
                  role="gridcell"
                >
                  <span className="coordinate">{squareName(position)}</span>
                  {game.looseBall === position && <span className="loose-ball" title="无人持有的足球">●</span>}
                  {player && <span className={`player-token ${player.team} ${setupSelected ? "selected" : ""} ${player.id === current.id ? "current" : ""} ${player.id === visibleEvent?.actorId && visibleEvent?.kind !== "goal" ? "event-actor" : ""} ${player.id === visibleEvent?.targetId ? "event-target" : ""}`}>
                    <span className="jersey">{player.id.slice(1)}</span><strong>{player.label}</strong><small>{player.hand.length} 手牌</small>
                    {hasBall(player) && <span className="ball" title="公开持球者">●</span>}
                  </span>}
                </button>;
              })}
              {ALL_GOALS.map((goal) => {
                const coordinate = toViewCoordinate(goal);
                const team = BLUE_GOALS.includes(goal as (typeof BLUE_GOALS)[number]) ? "blue" : "red";
                return <button
                  key={goal}
                  className={`external-goal ${team} ${validCells.has(goal) ? "valid" : ""}`}
                  style={{ left: `${coordinate.col * (100 / BOARD_WIDTH)}%`, top: coordinate.row < 0 ? "-4.8%" : "100%" }}
                  onClick={() => onCellClick(goal)}
                  aria-label={`${squareName(goal)}${validCells.has(goal) ? "，可射门" : ""}`}
                ><span className="goal-net"><i /><i /><i /></span></button>;
              })}
            </div>
            <div className="file-labels" aria-hidden="true">{fileLabels.map((file) => <span key={file}>{file}</span>)}</div>
          </div>
          <div className="pitch-legend"><span><i className="legend-dot available" />可选位置</span><span><i className="legend-dot football" />足球位置始终公开</span><span><i className="legend-dot goal" />从禁区外射入双格球门得分</span></div>
        </section>

        <aside className="control-column">
          <section className="phase-card"><p className="section-label">MATCH DIRECTOR</p><h2>{phaseCopy[0]}</h2><p>{phaseCopy[1]}</p><div className="phase-rule"><span>{game.phase === "turn" ? `行动力 ${game.turn.actionsRemaining}` : "LIVE"}</span><i /></div></section>
          {aiThinking && actorId && <section className="ai-thinking-panel" aria-live="polite"><span className="ai-pulse" /><div><strong>{playerById(game, actorId).label} 正在思考</strong><small>AI 会逐步行动，高收益选择更常出现但不固定。</small></div></section>}
          {!isMultiplayer && game.aiNote && <p className="ai-note"><strong>最近一次 AI 判断</strong>{game.aiNote}</p>}

          {(game.phase === "setup" || game.phase === "kickoff") && <section className="action-card-panel">
            <div className="panel-title-row"><h3>{isMultiplayer ? "阵型准备" : "选择阵营并布阵"}</h3><span>{isMultiplayer ? `${describeTeam(playerById(game, humanPlayerId).team)} · ${playerById(game, humanPlayerId).label}` : "你控制全队 · 对方由 AI 控制"}</span></div>
            {game.phase === "setup" && !isMultiplayer && <>
              <p className="action-hint">选择本局由你控制的球队。开赛后不能更换。</p>
              <div className="human-player-picker team-picker">{(["red", "blue"] as Team[]).map((team) => { const representative = game.players.find((player) => player.team === team)!; return <button key={team} className={`${team} ${playerById(game, humanPlayerId).team === team ? "selected" : ""}`} onClick={() => { setHandView({ turnActorId: "", playerId: representative.id }); onChooseHumanPlayer(representative.id); }}>{describeTeam(team)}<small>控制全部球员</small></button>; })}</div>
            </>}
            <p className="action-hint">选择己方球员，再点击棋盘空格调整位置。</p>
            <div className="formation-list">{game.players.map((player) => <button key={player.id} disabled={!isHumanControlled(player.id)} className={`${player.team} ${player.id === setupPlayerId ? "selected" : ""} ${isHumanControlled(player.id) ? "human" : isMultiplayer ? "remote-player" : "ai"}`} onClick={() => isHumanControlled(player.id) && setSetupPlayerId(player.id)}>{player.label}<small>{isHumanControlled(player.id) ? `YOU · ${squareName(player.position)}` : `${isMultiplayer ? "其他玩家" : "AI"} · ${squareName(player.position)}`}</small></button>)}</div>
            <div className={`action-row ${isMultiplayer ? "single" : ""}`}>{!isMultiplayer && <button className="secondary-action" onClick={onResetPositions}>默认阵型</button>}<button className="primary-action" disabled={!canConfirmKickoff} onClick={onStartKickoff}>{canConfirmKickoff ? game.phase === "setup" ? "开始比赛" : "确认开球" : game.phase === "setup" ? "等待房主开赛" : `等待 ${activePlayer(game).label} 开球`}</button></div>
          </section>}

          {game.phase === "gameover" && <section className={`winner-card ${game.winner}`}><span>FULL TIME</span><strong>{game.scores.red} — {game.scores.blue}</strong>{!isMultiplayer && <button onClick={onRestartGame}>再来一局</button>}</section>}
        </aside>
      </div>

      <section className={`command-deck ${humanTurn ? "your-turn" : ""}`}>
      <section className="hand-dock" aria-label={`${focusPlayer.label} 手牌`}>
        <div className="hand-owner"><span className={`owner-badge ${focusPlayer.team}`}>{focusPlayer.label}</span><div><strong>{focusIsHuman ? "你的手牌" : isMultiplayer ? "其他玩家的手牌" : "AI 手牌"}</strong><small>{focusIsHuman ? "足球不计入手牌上限" : "牌面隐藏 · 持球者仍公开"}</small></div><b>{countedHandSize(focusPlayer)} / {handLimit(game, focusPlayer)}{hasBall(focusPlayer) ? " + 球" : ""}</b></div>
        <div className="card-fan">
          {!focusIsHuman && focusPlayer.hand.map((card, index) => <span key={`${card.id}-${index}`} className="play-card hidden-card" aria-label={isMultiplayer ? "对手暗牌" : "AI 暗牌"}><span className="card-corner">PASS</span><strong>?</strong><h4>HIDDEN</h4><small>UNKNOWN CARD</small></span>)}
          {focusIsHuman && focusPlayer.hand.map((card) => {
            const active = game.phase === "turn" && focusPlayer.id === current.id;
            const discarding = game.phase === "discard" && game.discardQueue[0] === focusPlayer.id;
            const selected = active && selectedCardId === card.id;
            const info = card.kind === "ball" ? { name: "BALL", icon: "●", caption: "FOOTBALL" } : card.kind === "action" ? SUIT_INFO[card.suit] : SPECIAL_INFO[card.special];
            return <button key={card.id} className={`play-card ${card.kind} ${selected ? "selected" : ""} ${discarding && card.kind !== "ball" ? "discardable" : ""}`} disabled={card.kind === "ball" || (!active && !discarding) || !controlsEnabled} onClick={() => { if (card.kind === "ball") return; if (discarding) { onDiscardOverflow(card.id); return; } setSelectedCardId(selected ? null : card.id); setActionMode(null); }}><span className="card-corner">{info.name}</span>{card.kind !== "ball" && <span className="card-cost" title="行动力费用">{card.cost}</span>}<strong>{card.kind === "action" ? <SuitIcon suit={card.suit} /> : info.icon}</strong><h4>{info.caption}</h4><small>{card.kind === "ball" ? "具体位置仅持有者可见" : card.kind === "action" ? "MOVE · PASS · PRESS" : SPECIAL_INFO[card.special].description}</small></button>;
          })}
        </div>
      </section>
        <aside className="quick-actions" aria-label="当前可用操作">
          {humanTurn && controlsEnabled && <section className="action-card-panel">
            <div className="panel-title-row"><h3>你的操作</h3><span>{game.turn.actionsRemaining} 点行动力</span></div>
            {selectedCard?.kind === "action" ? <div className="mode-grid command-modes">
              <button disabled={!canAct(game)} className={actionMode === "move" ? "active" : ""} onClick={() => setActionMode("move")}>移动<small>选择棋盘高亮格</small></button>
              {hasBall(current) && <button disabled={!canAct(game)} className={actionMode === "pass" ? "active" : ""} onClick={() => setActionMode("pass")}>传球<small>选择队友或落点</small></button>}
            </div> : <p className="action-hint dock-hint">{selectedCard ? "选择这张特殊卡的用法。" : "先选择左侧手牌，操作会立即显示在这里。"}</p>}
            {current.team !== game.offense && <div className="mode-grid"><button disabled={!canAct(game) || !selectedCard} className={actionMode === "press" ? "active" : ""} onClick={() => setActionMode("press")}>上抢<small>弃所选牌 · 可重复使用</small></button></div>}
            {selectedCard?.kind === "special" && selectedCard.special === "tackle" && <div className="mode-grid"><button disabled={!canAct(game) || game.turn.tackleUsed} className={actionMode === "tackle" ? "active" : ""} onClick={() => setActionMode("tackle")}>抢断<small>点击一格内的对手</small></button></div>}
            {selectedCard?.kind === "special" && selectedCard.special === "flying-kick" && <div className="mode-grid"><button disabled={!canAct(game)} className={actionMode === "flying-kick" ? "active" : ""} onClick={() => setActionMode("flying-kick")}>飞踢<small>点击一步内的对手</small></button></div>}
            {selectedCard?.kind === "special" && ["sprint", "supply", "long-pass"].includes(selectedCard.special) && <button className="primary-action full" disabled={(selectedCard.cost > game.turn.actionsRemaining) || (selectedCard.special === "long-pass" && (!hasBall(current) || game.turn.longPassReady))} onClick={onPerformImmediateSpecial}>使用 {SPECIAL_INFO[selectedCard.special].caption}</button>}
            {selectedCard?.kind === "special" && selectedCard.special === "save" && <button className="primary-action full" disabled={current.team !== game.offense} onClick={onPerformImmediateSpecial}>{current.team === game.offense ? "弃置扑救并抽1张" : "等待对方传球时响应"}</button>}
            {game.turn.longPassReady && <p className="status-chip">长传已准备：下一次传球可越过 1 人</p>}
            <div className="dock-actions"><button className="draw-action compact" disabled={game.turn.cardsPlayed !== 0} onClick={onSkipPlayAndDraw}>战术整备 · 抽 {SKIP_PLAY_DRAW}</button><button className="secondary-action" onClick={onEndPlayPhase}>结束回合</button></div>
          </section>}
          {humanSaveResponse && controlsEnabled && responsePlayer && responseSaveCard && <section className="action-card-panel save-response-panel">
            <div className="panel-title-row"><h3>扑救响应</h3><span>传球未完成</span></div>
            <p className="action-hint">选择 X 张牌，再点击高亮格移动 X 步。</p>
            <div className="save-discard-grid">{responseExtraCards.map((card) => <button key={card.id} className={saveDiscardIds.includes(card.id) ? "selected" : ""} onClick={() => toggleSaveDiscard(card.id)}><strong>{card.kind === "action" ? <SuitIcon suit={card.suit} /> : SPECIAL_INFO[card.special].icon}</strong><span>{card.kind === "action" ? SUIT_INFO[card.suit].name : SPECIAL_INFO[card.special].name}</span></button>)}</div>
            <button className="secondary-action full" onClick={onDeclineSave}>放弃扑救</button>
          </section>}
          {game.phase === "discard" && isHumanControlled(game.discardQueue[0]) && controlsEnabled && <section className="action-card-panel"><div className="panel-title-row"><h3>请选择弃牌</h3><span>{countedHandSize(focusPlayer)} / {handLimit(game, focusPlayer)}</span></div><p className="action-hint">直接点击左侧需要弃置的牌。</p></section>}
          {!humanTurn && !humanSaveResponse && !(game.phase === "discard" && isHumanControlled(game.discardQueue[0])) && <section className="waiting-command"><span>{phaseCopy[0]}</span><strong>{phaseCopy[1]}</strong></section>}
        </aside>
      </section>
    </main>
  );
}
