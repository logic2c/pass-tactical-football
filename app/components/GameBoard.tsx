"use client";

import { type CSSProperties } from "react";
import { BLUE_GOAL, RED_GOAL, isGoal } from "@/shared/game-rules";
import type {
  ActionCard,
  ActionMode,
  GameState,
  PlayCard,
  SpecialCard,
  Suit,
  SpecialKind,
  VisualEvent,
} from "@/shared/types";
import {
  AI_TUNING,
  FILES,
  GAME_BALANCE,
  SPECIAL_INFO,
  SUIT_INFO,
  TURN_ORDER,
  describeTeam,
} from "@/shared/constants";
import {
  actionCards,
  activePlayer,
  canAct,
  countedHandSize,
  exactStepPaths,
  hasBall,
  handLimit,
  isAdjacent,
  isOwnHalf,
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

export interface GameBoardProps {
  game: GameState;
  humanPlayerId: string;
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
}

export default function GameBoard({
  game,
  humanPlayerId,
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
}: GameBoardProps) {
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

  // Check if it's the human's turn in multiplayer (to disable controls)
  const isMyTurn = !isMultiplayer || actorId === humanPlayerId;
  const controlsEnabled = !isMultiplayer || isMyTurn;

  const phaseCopy = (() => {
    if (game.phase === "setup") return ["选择角色并布阵", "选择你控制的一名球员；其余球员由 AI 控制。"];
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
        {TURN_ORDER.map((id, index) => {
          const player = playerById(game, id);
          return <div key={id} className={`turn-chip ${player.team} ${player.id === humanPlayerId ? "human" : "ai"} ${index === game.turnIndex ? "active" : ""}`}>
            <i>{index + 1}</i>{player.label}{hasBall(player) && <b title="公开持球者">●</b>}<small>{player.id === humanPlayerId ? "YOU" : isMultiplayer ? "玩家" : "AI"}</small>
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
                const closeInteractionTarget = humanTurn && controlsEnabled && player && player.team !== current.team && (
                  ((actionMode === "tackle" || actionMode === "press") && player.hand.length > 0 && isAdjacent(current.position, player.position)) ||
                  (actionMode === "flying-kick" && isStepAdjacent(current.position, player.position))
                );
                const eventFrom = visibleEvent?.from === position;
                const eventTo = visibleEvent?.to === position || visibleEvent?.ballSquare === position;
                const eventRoute = eventPath.has(position);
                return <button
                  key={position}
                  className={`pitch-cell ${(Math.floor(position / 8) + position) % 2 ? "stripe" : ""} ${valid ? "valid" : ""} ${goal ? `goal ${goal}` : ""} ${closeInteractionTarget ? "tackle-target" : ""} ${eventRoute ? "event-route" : ""} ${eventFrom ? "event-from" : ""} ${eventTo ? "event-to" : ""}`}
                  onClick={() => onCellClick(position)}
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
            <div className="panel-title-row"><h3>人机配置</h3><span>{isMultiplayer ? `${game.players.length} 玩家` : "1 HUMAN · 5 AI"}</span></div>
            {game.phase === "setup" && <>
              <p className="action-hint">{isMultiplayer ? "选择你的球员位置。" : "选择本局由你控制的球员。开赛后不能更换。"}</p>
              <div className="human-player-picker">{game.players.map((player) => <button key={player.id} className={`${player.team} ${player.id === humanPlayerId ? "selected" : ""}`} onClick={() => onChooseHumanPlayer(player.id)}>{player.label}<small>{describeTeam(player.team)}</small></button>)}</div>
            </>}
            <p className="action-hint">调整 {playerById(game, humanPlayerId).label} 的位置。</p>
            <div className="formation-list">{game.players.map((player) => <button key={player.id} disabled={player.id !== humanPlayerId} className={`${player.team} ${player.id === humanPlayerId ? "selected human" : "ai"}`} onClick={() => player.id === humanPlayerId && setSetupPlayerId(player.id)}>{player.label}<small>{player.id === humanPlayerId ? `YOU · ${squareName(player.position)}` : `${isMultiplayer ? "玩家" : "AI"} · ${squareName(player.position)}`}</small></button>)}</div>
            <div className="action-row"><button className="secondary-action" onClick={onResetPositions}>默认阵型</button><button className="primary-action" onClick={onStartKickoff}>{game.phase === "setup" ? "开始比赛" : "确认开球"}</button></div>
          </section>}

          {humanTurn && controlsEnabled && <section className="action-card-panel">
            <div className="panel-title-row"><h3>出牌阶段</h3><span>{current.team === game.offense ? "进攻方" : "防守方"}</span></div>
            <button className="draw-action" disabled={game.turn.cardsPlayed !== 0} onClick={onSkipPlayAndDraw}><span>蓄力</span><strong>+{SKIP_PLAY_DRAW}</strong><small>尚未行动时跳过整个出牌阶段</small></button>
            {game.turn.longPassReady && <p className="status-chip">长传已准备：下一次 PASS 可越过 1 人，不能射门</p>}
            <div className="action-row"><button className="secondary-action" onClick={onEndPlayPhase}>结束出牌</button></div>
            {selectedCard?.kind === "action" && <div className="mode-grid">
              <button disabled={!canAct(game)} className={actionMode === "move" ? "active" : ""} onClick={() => setActionMode("move")}>MOVE<small>费用1点行动力</small></button>
              {hasBall(current) && <button disabled={!canAct(game)} className={actionMode === "pass" ? "active" : ""} onClick={() => setActionMode("pass")}>PASS<small>传球后结束出牌</small></button>}
            </div>}
            {current.team !== game.offense && <div className="mode-grid"><button disabled={!canAct(game) || game.turn.pressUsed} className={actionMode === "press" ? "active" : ""} onClick={() => { setSelectedCardId(null); setActionMode("press"); }}>PRESS<small>近身无卡上抢</small></button></div>}
            {selectedCard?.kind === "special" && selectedCard.special === "tackle" && <div className="mode-grid"><button disabled={!canAct(game) || game.turn.tackleUsed} className={actionMode === "tackle" ? "active" : ""} onClick={() => setActionMode("tackle")}>TACKLE<small>双方可用 · 一格内抢牌</small></button></div>}
            {selectedCard?.kind === "special" && selectedCard.special === "flying-kick" && <div className="mode-grid"><button disabled={!canAct(game)} className={actionMode === "flying-kick" ? "active" : ""} onClick={() => setActionMode("flying-kick")}>飞踢<small>一步内 · 下回合行动力−1</small></button></div>}
            {selectedCard?.kind === "special" && ["sprint", "supply", "long-pass"].includes(selectedCard.special) && <button className="primary-action full" disabled={(selectedCard.cost > game.turn.actionsRemaining) || (selectedCard.special === "long-pass" && (!hasBall(current) || game.turn.longPassReady))} onClick={onPerformImmediateSpecial}>使用 {SPECIAL_INFO[selectedCard.special].caption}</button>}
            {selectedCard?.kind === "special" && selectedCard.special === "save" && <button className="primary-action full" disabled={current.team !== game.offense} onClick={onPerformImmediateSpecial}>{current.team === game.offense ? "弃置扑救并抽1张" : "扑救仅在对方Pass时响应"}</button>}
            {actionMode === "move" && <p className="action-hint">点击高亮位置。移动路径经过落地足球时会立即获得足球。</p>}
            {actionMode === "pass" && <p className="action-hint">点击高亮空格或队友传球；任何球员都会阻挡线路，最先挡路的队友可以直接接球。</p>}
            {actionMode === "tackle" && <p className="action-hint">点击王的一格以内的对手；抽到的牌都会加入手牌。</p>}
            {actionMode === "flying-kick" && <p className="action-hint">点击横向或纵向相邻一步的对手；若其持球则直接夺取足球。</p>}
            {actionMode === "press" && <p className="action-hint">点击王的一格以内的对手；只有抽中足球才会拿走，否则原样放回。</p>}
          </section>}

          {humanSaveResponse && controlsEnabled && responsePlayer && responseSaveCard && <section className="action-card-panel save-response-panel">
            <div className="panel-title-row"><h3>扑救响应</h3><span>PASS 尚未完成</span></div>
            <p className="action-hint">扑救卡会自动弃置。再选择 X 张牌，即可移动 X 步；点击高亮格执行扑救。</p>
            <div className="save-discard-grid">{responseExtraCards.map((card) => <button key={card.id} className={saveDiscardIds.includes(card.id) ? "selected" : ""} onClick={() => toggleSaveDiscard(card.id)}><strong>{card.kind === "action" ? SUIT_INFO[card.suit].icon : SPECIAL_INFO[card.special].icon}</strong><span>{card.kind === "action" ? SUIT_INFO[card.suit].name : SPECIAL_INFO[card.special].name}</span></button>)}</div>
            <p className="response-summary">已选 {saveDiscardIds.length} 张 · 可移动 {saveDiscardIds.length} 步</p>
            <button className="secondary-action full" onClick={onDeclineSave}>放弃扑救，让 Pass 继续</button>
          </section>}

          {game.phase === "discard" && game.discardQueue[0] === humanPlayerId && controlsEnabled && <section className="action-card-panel"><div className="panel-title-row"><h3>弃牌阶段</h3><span>{countedHandSize(focusPlayer)} / {handLimit(game, focusPlayer)}{hasBall(focusPlayer) ? " + 球" : ""}</span></div><div className="revealed-hand compact">{focusPlayer.hand.map((card) => <button key={card.id} className={card.kind} disabled={card.kind === "ball"} onClick={() => onDiscardOverflow(card.id)}><strong>{card.kind === "ball" ? "●" : card.kind === "action" ? SUIT_INFO[card.suit].icon : SPECIAL_INFO[card.special].icon}</strong><span>{card.kind === "ball" ? "FOOTBALL" : card.kind === "action" ? SUIT_INFO[card.suit].name : SPECIAL_INFO[card.special].name}</span></button>)}</div></section>}

          {game.phase === "gameover" && <section className={`winner-card ${game.winner}`}><span>FULL TIME</span><strong>{game.scores.red} — {game.scores.blue}</strong>{!isMultiplayer && <button onClick={onRestartGame}>再来一局</button>}</section>}
          <section className="match-log"><div className="panel-title-row"><h3>比赛记录</h3><span>最新在前</span></div><div className="log-scroll">{game.log.map((message, index) => <p key={`${message}-${index}`}><i>{String(game.log.length - index).padStart(2, "0")}</i>{message}</p>)}</div></section>
        </aside>
      </div>

      <section className="hand-dock" aria-label={`${focusPlayer.label} 手牌`}>
        <div className="hand-owner"><span className={`owner-badge ${focusPlayer.team}`}>{focusPlayer.label}</span><div><strong>{focusIsHuman ? "你的手牌" : isMultiplayer ? "其他玩家的手牌" : "AI 手牌"}</strong><small>{focusIsHuman ? "足球不计入手牌上限" : "牌面隐藏 · 持球者仍公开"}</small></div><b>{countedHandSize(focusPlayer)} / {handLimit(game, focusPlayer)}{hasBall(focusPlayer) ? " + 球" : ""}</b></div>
        <div className="card-fan">
          {!focusIsHuman && focusPlayer.hand.map((card, index) => <span key={`${card.id}-${index}`} className="play-card hidden-card" aria-label={isMultiplayer ? "对手暗牌" : "AI 暗牌"}><span className="card-corner">PASS</span><strong>?</strong><h4>HIDDEN</h4><small>UNKNOWN CARD</small></span>)}
          {focusIsHuman && focusPlayer.hand.map((card) => {
            const active = game.phase === "turn" && focusPlayer.id === current.id;
            const selected = active && selectedCardId === card.id;
            const info = card.kind === "ball" ? { name: "BALL", icon: "●", caption: "FOOTBALL" } : card.kind === "action" ? SUIT_INFO[card.suit] : SPECIAL_INFO[card.special];
            return <button key={card.id} className={`play-card ${card.kind} ${selected ? "selected" : ""}`} disabled={!active || card.kind === "ball" || !controlsEnabled} onClick={() => { if (card.kind === "ball") return; setSelectedCardId(selected ? null : card.id); setActionMode(null); }}><span className="card-corner">{info.name}</span>{card.kind !== "ball" && <span className="card-cost" title="行动力费用">{card.cost}</span>}<strong>{info.icon}</strong><h4>{info.caption}</h4><small>{card.kind === "ball" ? "具体位置仅持有者可见" : card.kind === "action" ? "MOVE · PASS" : SPECIAL_INFO[card.special].description}</small></button>;
          })}
        </div>
      </section>
    </main>
  );
}
