"use client";

import { useEffect, useState, useMemo, useRef, useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import TutorialGame from "./components/TutorialGame";
import type {
  ActionMode,
  GameAction,
  GameState,
  RoomState,
  Team,
} from "@/shared/types";
import {
  AI_TUNING,
  GAME_BALANCE,
  describeTeam,
} from "@/shared/constants";
import {
  activePlayer,
  addLog,
  autoFinishTurnIfNeeded,
  createGame,
  declineSaveResponse,
  discardOverflowAction,
  drawInto,
  emitEvent,
  enterCurrentTurn,
  finishPlayPhase,
  isLegalSetupPosition,
  playerById,
  resetFormation,
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
} from "@/shared/game-engine";
import {
  phaseActorId,
  runAiStep,
} from "@/shared/ai-engine";
import LobbyPanel from "./components/LobbyPanel";
import GameBoard from "./components/GameBoard";
import ReconnectOverlay from "./components/ReconnectOverlay";
import { getWsUrl } from "@/shared/ws-url";

// Re-export for desktop/main.tsx
export { createGame } from "@/shared/game-engine";
export type { GameState, GameCard, PlayCard, ActionCard, SpecialCard, Team, Suit, SpecialKind, ActionMode, VisualEvent } from "@/shared/types";

const SKIP_PLAY_DRAW = GAME_BALANCE.skipPlayDraw;

// ── Multiplayer mode ──

function getRoomFromURL(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("room");
}

function MultiplayerApp() {
  const roomCode = useMemo(() => getRoomFromURL(), []);
  const [mode] = useState<"create" | "join">(roomCode ? "join" : "create");
  const [phase, setPhase] = useState<"lobby" | "playing">("lobby");
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [myPositionIds, setMyPositionIds] = useState<string[]>([]);
  const myPositionId = myPositionIds[0] ?? "";
  const [isHost, setIsHost] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef({ playerId: "", roomCode: "", reconnectToken: "" });
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 30;
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectMsg, setReconnectMsg] = useState("");

  // Local UI state (same as single player)
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<ActionMode>(null);
  const [setupPlayerId, setSetupPlayerId] = useState("");
  const [saveDiscardIds, setSaveDiscardIds] = useState<string[]>([]);

  function rememberSession(playerId: string, room: string, reconnectToken: string) {
    sessionRef.current = { playerId, roomCode: room, reconnectToken };
    try { sessionStorage.setItem("pass-playerId", playerId); } catch { /* storage unavailable */ }
    try { sessionStorage.setItem("pass-roomCode", room); } catch { /* storage unavailable */ }
    try { sessionStorage.setItem("pass-reconnectToken", reconnectToken); } catch { /* storage unavailable */ }
  }

  function applyRoomState(state: RoomState) {
    if (state.gameState) setGameState(state.gameState);
    const mySlot = state.slots.find((slot) => slot.playerId === sessionRef.current.playerId);
    if (mySlot?.positionId) {
      const ownedIds = mySlot.positionIds.length > 0 ? mySlot.positionIds : [mySlot.positionId];
      setMyPositionIds(ownedIds);
      setSetupPlayerId((currentId) => ownedIds.includes(currentId) ? currentId : ownedIds[0]);
    }
    if (mySlot) setIsHost(mySlot.isHost);
  }

  function scheduleReconnect(closedSocket: WebSocket) {
    if (disposedRef.current || wsRef.current !== closedSocket) return;
    if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
      setReconnecting(false);
      setReconnectMsg("自动重连未成功，你可以继续手动重试。");
      return;
    }
    const attempt = reconnectAttemptsRef.current + 1;
    const delay = Math.min(800 * Math.pow(1.45, reconnectAttemptsRef.current), 8000);
    reconnectAttemptsRef.current = attempt;
    setReconnecting(true);
    setReconnectMsg(`连接中断，正在恢复对局（${attempt}/${maxReconnectAttempts}）`);
    reconnectTimerRef.current = setTimeout(openResumeSocket, delay);
  }

  function bindGameSocket(socket: WebSocket, resume: boolean) {
    wsRef.current = socket;
    socket.onopen = () => {
      if (!resume) return;
      const session = sessionRef.current;
      socket.send(JSON.stringify({
        type: "join-room",
        payload: {
          roomCode: session.roomCode,
          reconnectToken: session.reconnectToken,
          displayName: "",
        },
      }));
    };
    socket.onmessage = (event) => {
      if (wsRef.current !== socket) return;
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "welcome") {
          const token = String(msg.payload.reconnectToken || sessionRef.current.reconnectToken);
          rememberSession(String(msg.payload.playerId), String(msg.payload.roomCode), token);
          reconnectAttemptsRef.current = 0;
          setReconnecting(false);
          setReconnectMsg("");
        } else if (msg.type === "room-state") {
          applyRoomState(msg.payload as RoomState);
        } else if (msg.type === "game-state") {
          setGameState(msg.payload as GameState);
        } else if (msg.type === "error") {
          setReconnecting(false);
          setReconnectMsg(String(msg.payload?.message || "连接出现问题，请重试。"));
        }
      } catch {
        setReconnectMsg("收到的比赛状态无法解析，正在重新连接。");
        socket.close();
      }
    };
    socket.onclose = () => scheduleReconnect(socket);
    socket.onerror = () => { /* close event owns retry scheduling */ };
  }

  function openResumeSocket() {
    if (disposedRef.current) return;
    const session = sessionRef.current;
    if (!session.playerId || !session.roomCode || !session.reconnectToken) {
      setReconnecting(false);
      setReconnectMsg("没有找到可恢复的对局凭证，请从邀请链接重新加入。");
      return;
    }
    bindGameSocket(new WebSocket(getWsUrl()), true);
  }

  function handleLobbyReady(transport: {
    ws: WebSocket;
    sendRoomAction: (type: string, payload: unknown) => void;
    playerId: string;
    roomCode: string;
    reconnectToken: string;
    myPositionIds: string[];
    isHost: boolean;
    initialGameState?: GameState;
  }) {
    setMyPositionIds(transport.myPositionIds);
    setSetupPlayerId(transport.myPositionIds[0] ?? "");
    setIsHost(transport.isHost);
    wsRef.current = transport.ws;
    reconnectAttemptsRef.current = 0;
    rememberSession(transport.playerId, transport.roomCode, transport.reconnectToken);

    // Apply the already-received game state immediately
    if (transport.initialGameState) {
      setGameState(transport.initialGameState);
    }

    bindGameSocket(transport.ws, false);
    setPhase("playing");
  }

  /** Manual reconnect */
  function handleManualReconnect() {
    reconnectAttemptsRef.current = 0;
    setReconnecting(true);
    setReconnectMsg("手动重连中...");
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    openResumeSocket();
  }

  useEffect(() => () => {
    disposedRef.current = true;
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    const socket = wsRef.current;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
  }, []);

  // Send a game command through WebSocket
  const sendGameCommand = useCallback((action: GameAction) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: "game-command",
        payload: action,
      }));
    }
  }, []);

  // Action handlers for multiplayer
  function handleCellClick(position: number) {
    const game = gameState;
    if (!game) return;

    if (game.phase === "setup" || game.phase === "kickoff") {
      const selected = playerById(game, setupPlayerId);
      if (!myPositionIds.includes(selected.id) || !isLegalSetupPosition(game, selected, position)) return;
      sendGameCommand({ kind: "setup-position", actorId: selected.id, position });
      return;
    }

    const current = activePlayer(game);
    const humanTurn = game.phase === "turn" && myPositionIds.includes(current.id);
    const responsePlayer = game.phase === "save-response" && game.pendingPass?.responderId
      ? playerById(game, game.pendingPass.responderId)
      : undefined;
    const humanSaveResponse = game.phase === "save-response" && Boolean(responsePlayer && myPositionIds.includes(responsePlayer.id));

    if (!humanTurn && !humanSaveResponse) return;

    const target = game.players.find((p) => p.position === position);
    const selectedCard = current.hand.find((c) => c.id === selectedCardId && c.kind !== "ball");

    if (humanSaveResponse) {
      sendGameCommand({ kind: "save-response", extraCardIds: saveDiscardIds, destination: position });
      setSaveDiscardIds([]);
    } else if (actionMode === "move" && selectedCard?.kind === "action") {
      sendGameCommand({ kind: "move", cardId: selectedCard.id, position });
    } else if (actionMode === "pass" && selectedCard?.kind === "action") {
      sendGameCommand({ kind: "pass", cardId: selectedCard.id, position });
    } else if (actionMode === "tackle" && target && selectedCard?.kind === "special") {
      sendGameCommand({ kind: "tackle", cardId: selectedCard.id, targetId: target.id });
    } else if (actionMode === "flying-kick" && target && selectedCard?.kind === "special") {
      sendGameCommand({ kind: "flying-kick", cardId: selectedCard.id, targetId: target.id });
    } else if (actionMode === "press" && target && selectedCard) {
      sendGameCommand({ kind: "press", cardId: selectedCard.id, targetId: target.id });
    }

    clearSelections();
  }

  function clearSelections() {
    setSelectedCardId(null);
    setActionMode(null);
    setSaveDiscardIds([]);
  }

  function handleStartKickoff() {
    sendGameCommand({ kind: "confirm-kickoff" });
    clearSelections();
  }

  function handleSkipPlayAndDraw() {
    sendGameCommand({ kind: "skip-draw" });
    clearSelections();
  }

  function handleEndPlayPhase() {
    sendGameCommand({ kind: "end-turn" });
    clearSelections();
  }

  function handlePerformImmediateSpecial() {
    const game = gameState;
    if (!game) return;
    const current = activePlayer(game);
    const selectedCard = current.hand.find((c) => c.id === selectedCardId && c.kind !== "ball");
    if (!selectedCard || selectedCard.kind !== "special") return;

    if (selectedCard.special === "sprint") {
      sendGameCommand({ kind: "sprint", cardId: selectedCard.id });
    } else if (selectedCard.special === "supply") {
      sendGameCommand({ kind: "supply", cardId: selectedCard.id });
    } else if (selectedCard.special === "long-pass") {
      sendGameCommand({ kind: "long-pass", cardId: selectedCard.id });
    } else if (selectedCard.special === "save") {
      sendGameCommand({ kind: "save-recycle", cardId: selectedCard.id });
    }
    clearSelections();
  }

  function handleDeclineSave() {
    sendGameCommand({ kind: "decline-save" });
    clearSelections();
  }

  function handleDiscardOverflow(cardId: string) {
    sendGameCommand({ kind: "discard", cardId });
  }

  function toggleSaveDiscard(cardId: string) {
    setSaveDiscardIds((ids) => ids.includes(cardId) ? ids.filter((id) => id !== cardId) : [...ids, cardId]);
  }

  const showReconnect = reconnecting || !!reconnectMsg;

  if (phase === "lobby") {
    return (
      <div style={{ position: "relative", display: "flex", justifyContent: "center", padding: "2rem" }}>
        <LobbyPanel
          mode={mode}
          initialCode={roomCode || undefined}
          onReady={handleLobbyReady}
        />
        <ReconnectOverlay visible={showReconnect} message={reconnectMsg} onRetry={handleManualReconnect} />
      </div>
    );
  }

  // Game is starting/playing
  if (!gameState) {
    return (
      <div style={{ position: "relative", display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
        <p>等待游戏状态...</p>
        <ReconnectOverlay visible={showReconnect} message={reconnectMsg} onRetry={handleManualReconnect} />
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <GameBoard
        game={gameState}
        humanPlayerId={myPositionId}
        humanPlayerIds={myPositionIds}
        selectedCardId={selectedCardId}
        setSelectedCardId={(id) => { setSelectedCardId(id); setActionMode(null); }}
        actionMode={actionMode}
        setActionMode={setActionMode}
        setupPlayerId={setupPlayerId || myPositionId}
        setSetupPlayerId={setSetupPlayerId}
        saveDiscardIds={saveDiscardIds}
        toggleSaveDiscard={toggleSaveDiscard}
        onCellClick={handleCellClick}
        onChooseHumanPlayer={() => {}} // Multiplayer: position assigned by slot
        onStartKickoff={handleStartKickoff}
        onResetPositions={() => {}} // Not supported in multiplayer
        onSkipPlayAndDraw={handleSkipPlayAndDraw}
        onEndPlayPhase={handleEndPlayPhase}
        onPerformImmediateSpecial={handlePerformImmediateSpecial}
        onDeclineSave={handleDeclineSave}
        onDiscardOverflow={handleDiscardOverflow}
        onRestartGame={() => {}}
        isMultiplayer
        canConfirmKickoff={gameState.phase === "setup" ? isHost : myPositionIds.includes(activePlayer(gameState).id)}
      />
      <ReconnectOverlay visible={showReconnect} message={reconnectMsg} onRetry={handleManualReconnect} />
    </div>
  );
}

// ── SinglePlayer component ──

function SinglePlayerGame() {
  const [game, setGame] = useState<GameState>(() => createGame());
  const [humanTeam, setHumanTeam] = useState<Team>("red");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<ActionMode>(null);
  const [setupPlayerId, setSetupPlayerId] = useState("r1");
  const [saveDiscardIds, setSaveDiscardIds] = useState<string[]>([]);

  const actorId = phaseActorId(game);
  const current = activePlayer(game);
  const humanPlayerIds = useMemo(
    () => game.players.filter((player) => player.team === humanTeam).map((player) => player.id),
    [game.players, humanTeam],
  );
  const humanPlayerId = humanPlayerIds[0];
  const isHumanControlled = useCallback((playerId: string) => humanPlayerIds.includes(playerId), [humanPlayerIds]);
  const humanTurn = game.phase === "turn" && isHumanControlled(current.id);

  const startKickoff = useCallback(() => {
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
    setSelectedCardId(null);
    setActionMode(null);
    setSaveDiscardIds([]);
  }, []);

  // AI execution
  useEffect(() => {
    if (!actorId || isHumanControlled(actorId)) return;
    const delay = game.phase === "turn" || game.phase === "save-response"
      ? AI_TUNING.thinkDelay.turn
      : AI_TUNING.thinkDelay.phase;
    const timer = window.setTimeout(() => {
      setGame((previous) => {
        const expected = phaseActorId(previous);
        if (!expected || isHumanControlled(expected) || expected !== actorId) return previous;
        const next = structuredClone(previous);
        return runAiStep(next, humanPlayerIds) ? next : previous;
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [game, actorId, humanPlayerIds, isHumanControlled]);

  useEffect(() => {
    if (game.phase !== "kickoff" || activePlayer(game).team === humanTeam) return;
    const timer = window.setTimeout(() => startKickoff(), AI_TUNING.thinkDelay.phase);
    return () => window.clearTimeout(timer);
  }, [game, humanTeam, startKickoff]);

  function clearSelections() {
    setSelectedCardId(null);
    setActionMode(null);
    setSaveDiscardIds([]);
  }

  function applyTurnAction(previous: GameState, action: (next: GameState) => boolean) {
    const next = structuredClone(previous);
    if (!action(next)) return previous;
    autoFinishTurnIfNeeded(next);
    return next;
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
    const team = playerById(game, playerId).team;
    setHumanTeam(team);
    setSetupPlayerId(game.players.find((player) => player.team === team)!.id);
    clearSelections();
  }

  function skipPlayAndDraw() {
    if (!humanTurn || game.turn.cardsPlayed !== 0) return;
    setGame((previous) => {
      const next = structuredClone(previous);
      const player = activePlayer(next);
      drawInto(next, player, SKIP_PLAY_DRAW);
      addLog(next, `${player.label} 跳过出牌阶段，额外抽取 ${SKIP_PLAY_DRAW} 张牌。`);
      emitEvent(next, {
        kind: "skip-draw",
        actorId: player.id,
        label: `${player.label} 选择战术整备`,
        result: `跳过出牌阶段，额外抽取 ${SKIP_PLAY_DRAW} 张牌。`,
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

  function handleCellClick(position: number) {
    const responsePlayer = game.phase === "save-response" && game.pendingPass?.responderId
      ? playerById(game, game.pendingPass.responderId)
      : undefined;
    const humanSaveResponse = game.phase === "save-response" && Boolean(responsePlayer && isHumanControlled(responsePlayer.id));

    if (game.phase === "setup" || game.phase === "kickoff") {
      const selected = playerById(game, setupPlayerId);
      if (!isHumanControlled(selected.id) || !isLegalSetupPosition(game, selected, position)) return;
      setGame((previous) => {
        const next = structuredClone(previous);
        playerById(next, setupPlayerId).position = position;
        return next;
      });
      return;
    }
    if (!humanTurn && !humanSaveResponse) return;
    const target = game.players.find((player) => player.position === position);
    const selectedCard = current.hand.find(
      (card) => card.id === selectedCardId && card.kind !== "ball",
    ) as { kind: string; id: string; special?: string } | undefined;

    if (humanSaveResponse) {
      performSave(position);
    } else if (actionMode === "move" && selectedCard?.kind === "action") {
      performMove(position, selectedCard.id);
    } else if (actionMode === "pass" && selectedCard?.kind === "action") {
      performPass(position, selectedCard.id);
    } else if (actionMode === "tackle" && target && selectedCard?.kind === "special") {
      performTackle(target.id, selectedCard.id);
    } else if (actionMode === "flying-kick" && target && selectedCard?.kind === "special") {
      performFlyingKick(target.id, selectedCard.id);
    } else if (actionMode === "press" && target && selectedCard) {
      performPress(target.id, selectedCard.id);
    }
  }

  function performMove(position: number, cardId: string) {
    setGame((previous) => applyTurnAction(previous, (next) => resolveMoveAction(next, cardId, position)));
    clearSelections();
  }

  function performPass(position: number, cardId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolvePassAction(next, cardId, position, humanPlayerIds) ? next : previous;
    });
    clearSelections();
  }

  function performTackle(targetId: string, cardId: string) {
    setGame((previous) => applyTurnAction(previous, (next) => resolveTackleAction(next, cardId, targetId)));
    clearSelections();
  }

  function performPress(targetId: string, cardId: string) {
    setGame((previous) => applyTurnAction(previous, (next) => resolvePressAction(next, cardId, targetId)));
    clearSelections();
  }

  function performFlyingKick(targetId: string, cardId: string) {
    setGame((previous) => applyTurnAction(previous, (next) => resolveFlyingKickAction(next, cardId, targetId)));
    clearSelections();
  }

  function performImmediateSpecial() {
    const selectedCard = current.hand.find(
      (card) => card.id === selectedCardId && card.kind !== "ball",
    ) as { kind: string; id: string; special?: string } | undefined;
    if (!selectedCard || selectedCard.kind !== "special") return;

    setGame((previous) => applyTurnAction(previous, (next) => selectedCard.special === "sprint"
        ? resolveSprintAction(next, selectedCard.id)
        : selectedCard.special === "supply"
          ? resolveSupplyAction(next, selectedCard.id)
          : selectedCard.special === "long-pass"
            ? resolveLongPassAction(next, selectedCard.id)
            : selectedCard.special === "save"
              ? resolveSaveRecycle(next, selectedCard.id)
              : false));
    clearSelections();
  }

  function performSave(destination: number) {
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolveSaveResponse(next, saveDiscardIds, destination) ? next : previous;
    });
    clearSelections();
  }

  function toggleSaveDiscard(cardId: string) {
    setSaveDiscardIds((ids) => ids.includes(cardId) ? ids.filter((id) => id !== cardId) : [...ids, cardId]);
  }

  function declineSave() {
    setGame((previous) => {
      const next = structuredClone(previous);
      return declineSaveResponse(next) ? next : previous;
    });
    clearSelections();
  }

  function discardOverflow(cardId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      if (!isHumanControlled(next.discardQueue[0])) return previous;
      return discardOverflowAction(next, cardId) ? next : previous;
    });
  }

  function restartGame() {
    setGame(createGame());
    clearSelections();
    setSetupPlayerId(humanPlayerId);
  }

  return (
    <GameBoard
      game={game}
      humanPlayerId={humanPlayerId}
      humanPlayerIds={humanPlayerIds}
      selectedCardId={selectedCardId}
      setSelectedCardId={(id) => { setSelectedCardId(id); setActionMode(null); }}
      actionMode={actionMode}
      setActionMode={setActionMode}
      setupPlayerId={setupPlayerId}
      setSetupPlayerId={setSetupPlayerId}
      saveDiscardIds={saveDiscardIds}
      toggleSaveDiscard={toggleSaveDiscard}
      onCellClick={handleCellClick}
      onChooseHumanPlayer={chooseHumanPlayer}
      onStartKickoff={startKickoff}
      onResetPositions={resetPositions}
      onSkipPlayAndDraw={skipPlayAndDraw}
      onEndPlayPhase={endPlayPhase}
      onPerformImmediateSpecial={performImmediateSpecial}
      onDeclineSave={declineSave}
      onDiscardOverflow={discardOverflow}
      onRestartGame={restartGame}
    />
  );
}

// ── Router ──

export default function Home() {
  const routeMode = useSyncExternalStore(
    (listener) => {
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    },
    () => {
      const params = new URLSearchParams(window.location.search);
      if (params.has("tutorial")) return "tutorial";
      if (params.has("singleplayer")) return "singleplayer";
      return "multiplayer";
    },
    () => "multiplayer",
  );
  if (routeMode === "tutorial") return <TutorialGame />;
  if (routeMode === "singleplayer") {
    return (
      <>
        <Link className="multiplayer-launch" href="/">
          <span>LIVE</span><strong>返回联机大厅</strong><small>创建房间或通过邀请加入</small>
        </Link>
        <a className="tutorial-launch" href="?tutorial=1">
          <span>F1</span><strong>开始教学</strong><small>9 个互动关卡</small>
        </a>
        <SinglePlayerGame />
      </>
    );
  }
  return (
    <>
      <a className="tutorial-launch" href="?tutorial=1">
        <span>?</span><strong>新手教程</strong><small>从按键到完整进攻</small>
      </a>
      <MultiplayerApp />
    </>
  );
}
