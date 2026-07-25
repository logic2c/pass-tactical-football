"use client";

import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import type {
  ActionMode,
  GameAction,
  GameState,
  RoomState,
} from "@/shared/types";
import {
  AI_TUNING,
  GAME_BALANCE,
  describeTeam,
} from "@/shared/constants";
import {
  activePlayer,
  addLog,
  canAct,
  completePendingPass,
  createGame,
  declineSaveResponse,
  discardOverflowAction,
  drawInto,
  emitEvent,
  enterCurrentTurn,
  finishPlayPhase,
  hasBall,
  isGoal,
  isOwnHalf,
  moveBallTo,
  otherTeam,
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
  return params.get("room") || params.get("multiplayer");
}

function MultiplayerApp() {
  const roomCode = useMemo(() => getRoomFromURL(), []);
  const [mode] = useState<"create" | "join">(roomCode ? "join" : "create");
  const [phase, setPhase] = useState<"lobby" | "playing">("lobby");
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [myPlayerId, setMyPlayerId] = useState("");       // UUID from server
  const [myPositionId, setMyPositionId] = useState("");    // Game player ID like "r1"
  const wsRef = useRef<WebSocket | null>(null);
  const roomCodeRef = useRef<string>("");
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 20;
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectMsg, setReconnectMsg] = useState("");

  // Local UI state (same as single player)
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<ActionMode>(null);
  const [setupPlayerId, setSetupPlayerId] = useState("");
  const [saveDiscardIds, setSaveDiscardIds] = useState<string[]>([]);

  /** Set up onmessage to handle game-state from room-state messages */
  function setupGameStateListener(ws: WebSocket, playerId: string) {
    const originalOnMessage = ws.onmessage;
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "room-state") {
        const state = msg.payload as RoomState;
        if (state.gameState) {
          setGameState(state.gameState);
        }
        const mySlot = state.slots?.find((s: { playerId: string }) => s.playerId === playerId);
        if (mySlot?.positionId) {
          setMyPositionId(mySlot.positionId);
        }
      } else if (msg.type === "game-state") {
        setGameState(msg.payload);
      }
      // Forward to original handler if any
      if (originalOnMessage && originalOnMessage !== ws.onmessage) {
        originalOnMessage.call(ws, event);
      }
    };
  }

  /** Set up reconnection handler on the WebSocket */
  function setupReconnectHandler(ws: WebSocket, playerId: string, room: string) {
    ws.onclose = () => {
      if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
        setReconnecting(false);
        setReconnectMsg("重连失败，请刷新页面重新加入。");
        return;
      }

      setReconnecting(true);
      setReconnectMsg(`连接断开，正在重连 (${reconnectAttemptsRef.current + 1}/${maxReconnectAttempts})...`);

      const delay = Math.min(2000 * Math.pow(1.5, reconnectAttemptsRef.current), 10000);
      reconnectAttemptsRef.current++;

      setTimeout(() => {
        const newWs = new WebSocket(getWsUrl());
        newWs.onopen = () => {
          // Rejoin the room with existing playerId
          newWs.send(JSON.stringify({
            type: "join-room",
            payload: {
              roomCode: room,
              displayName: "",
              playerId: playerId,
            },
          }));
        };

        newWs.onmessage = (event) => {
          const msg = JSON.parse(event.data as string);
          if (msg.type === "welcome") {
            // Reconnected successfully
            reconnectAttemptsRef.current = 0;
            setReconnecting(false);
            wsRef.current = newWs;
            setupGameStateListener(newWs, playerId);
            setupReconnectHandler(newWs, playerId, room);
          }
        };

        newWs.onerror = () => {
          // Will trigger onclose
        };
      }, delay);
    };
  }

  function handleLobbyReady(transport: {
    ws: WebSocket;
    sendRoomAction: (type: string, payload: unknown) => void;
    playerId: string;
    roomCode: string;
  }) {
    setMyPlayerId(transport.playerId);
    setSetupPlayerId(transport.playerId);
    wsRef.current = transport.ws;
    roomCodeRef.current = transport.roomCode;
    reconnectAttemptsRef.current = 0;

    // Store for reconnection
    try { sessionStorage.setItem("pass-playerId", transport.playerId); } catch { /* */ }
    try { sessionStorage.setItem("pass-roomCode", transport.roomCode); } catch { /* */ }

    setupGameStateListener(transport.ws, transport.playerId);
    setupReconnectHandler(transport.ws, transport.playerId, transport.roomCode);
    setPhase("playing");
  }

  /** Manual reconnect */
  function handleManualReconnect() {
    reconnectAttemptsRef.current = 0;
    setReconnecting(true);
    setReconnectMsg("手动重连中...");

    const playerId = myPlayerId || (() => { try { return sessionStorage.getItem("pass-playerId") || ""; } catch { return ""; } })();
    const room = roomCodeRef.current || (() => { try { return sessionStorage.getItem("pass-roomCode") || ""; } catch { return ""; } })();

    if (!playerId || !room) {
      setReconnectMsg("未找到会话信息，请刷新页面重新加入。");
      return;
    }

    const newWs = new WebSocket(getWsUrl());
    newWs.onopen = () => {
      newWs.send(JSON.stringify({
        type: "join-room",
        payload: { roomCode: room, displayName: "", playerId },
      }));
    };
    newWs.onmessage = (event) => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === "welcome") {
        reconnectAttemptsRef.current = 0;
        setReconnecting(false);
        wsRef.current = newWs;
        if (!myPlayerId) setMyPlayerId(playerId);
        setupGameStateListener(newWs, playerId);
        setupReconnectHandler(newWs, playerId, room);
      }
    };
  }

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
      if (selected.id !== myPositionId || isGoal(position) || !isOwnHalf(selected, position)) return;
      if (game.players.some((p) => p.position === position && p.id !== selected.id)) return;
      sendGameCommand({ kind: "setup-position", position });
      return;
    }

    const current = activePlayer(game);
    const humanTurn = game.phase === "turn" && current.id === myPositionId;
    const responsePlayer = game.phase === "save-response" && game.pendingPass?.responderId
      ? playerById(game, game.pendingPass.responderId)
      : undefined;
    const humanSaveResponse = game.phase === "save-response" && responsePlayer?.id === myPositionId;

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
    } else if (actionMode === "press" && target) {
      sendGameCommand({ kind: "press", targetId: target.id });
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
      />
      <ReconnectOverlay visible={showReconnect} message={reconnectMsg} onRetry={handleManualReconnect} />
    </div>
  );
}

// ── SinglePlayer component ──

function SinglePlayerGame() {
  const [game, setGame] = useState<GameState>(() => createGame());
  const [humanPlayerId, setHumanPlayerId] = useState("r1");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [actionMode, setActionMode] = useState<ActionMode>(null);
  const [setupPlayerId, setSetupPlayerId] = useState("r1");
  const [saveDiscardIds, setSaveDiscardIds] = useState<string[]>([]);

  const actorId = phaseActorId(game);
  const current = activePlayer(game);
  const humanTurn = game.phase === "turn" && current.id === humanPlayerId;

  // AI execution
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
        return runAiStep(next, [humanPlayerId]) ? next : previous;
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
      drawInto(next, player, SKIP_PLAY_DRAW);
      addLog(next, `${player.label} 跳过出牌阶段，额外抽取 ${SKIP_PLAY_DRAW} 张牌。`);
      emitEvent(next, {
        kind: "skip-draw",
        actorId: player.id,
        label: `${player.label} 选择蓄力`,
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
    const humanSaveResponse = game.phase === "save-response" && responsePlayer?.id === humanPlayerId;

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
    } else if (actionMode === "press" && target) {
      performPress(target.id);
    }
  }

  function performMove(position: number, cardId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolveMoveAction(next, cardId, position) ? next : previous;
    });
    clearSelections();
  }

  function performPass(position: number, cardId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolvePassAction(next, cardId, position, humanPlayerId) ? next : previous;
    });
    clearSelections();
  }

  function performTackle(targetId: string, cardId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolveTackleAction(next, cardId, targetId) ? next : previous;
    });
    clearSelections();
  }

  function performPress(targetId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolvePressAction(next, targetId) ? next : previous;
    });
    clearSelections();
  }

  function performFlyingKick(targetId: string, cardId: string) {
    setGame((previous) => {
      const next = structuredClone(previous);
      return resolveFlyingKickAction(next, cardId, targetId) ? next : previous;
    });
    clearSelections();
  }

  function performImmediateSpecial() {
    const selectedCard = current.hand.find(
      (card) => card.id === selectedCardId && card.kind !== "ball",
    ) as { kind: string; id: string; special?: string } | undefined;
    if (!selectedCard || selectedCard.kind !== "special") return;

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
      if (next.discardQueue[0] !== humanPlayerId) return previous;
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
  const [isMultiplayer, setIsMultiplayer] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setIsMultiplayer(params.has("room") || params.has("multiplayer"));
    setMounted(true);
  }, []);

  if (!mounted) return null;

  if (isMultiplayer) {
    return <MultiplayerApp />;
  }

  return <SinglePlayerGame />;
}
