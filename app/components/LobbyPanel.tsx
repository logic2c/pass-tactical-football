"use client";

import { useEffect, useState, useRef } from "react";
import type { GameState, RoomMode, RoomState, Team } from "@/shared/types";
import { getWsUrl } from "@/shared/ws-url";

type Props = {
  mode: "create" | "join";
  initialCode?: string;
  onReady: (transport: {
    ws: WebSocket;
    sendRoomAction: (type: string, payload: unknown) => void;
    playerId: string;
    roomCode: string;
    reconnectToken: string;
    myPositionIds: string[];
    isHost: boolean;
    initialGameState?: GameState;
  }) => void;
};

const ROOM_MODE_LABELS: Record<RoomMode, string> = {
  "1v1": "1v1 · 2人",
  "2v2": "2v2 · 4人",
  "3v3": "3v3 传统 · 6人",
  "4v4": "4v4 传统 · 8人",
  "3v3-duel": "3v3 双人整队 · 2人",
  "4v4-duo": "4v4 四人搭档 · 4人",
};

function controllerSeatLabel(mode: RoomMode, team: Team, index: number) {
  const prefix = team === "red" ? "R" : "B";
  if (mode === "3v3-duel") return `${prefix}1 / ${prefix}2 / ${prefix}3`;
  if (mode === "4v4-duo") return index === 0 ? `${prefix}1 / ${prefix}3` : `${prefix}2 / ${prefix}4`;
  return `${prefix}${index + 1}`;
}

export default function LobbyPanel({ mode, initialCode, onReady }: Props) {
  const [displayName, setDisplayName] = useState("");
  const [roomCode, setRoomCode] = useState(initialCode || "");
  const [gameMode, setGameMode] = useState<RoomMode>("3v3-duel");
  const [step, setStep] = useState<"input" | "connecting">("input");
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [myPlayerId, setMyPlayerId] = useState("");
  const [reconnectToken, setReconnectToken] = useState("");
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [error, setError] = useState("");
  const connectingRef = useRef(false);
  const enteredGameRef = useRef(false);

  function enterGame(socket: WebSocket, state: RoomState, playerId: string, token: string) {
    if (enteredGameRef.current) return;
    const slot = state.slots.find((candidate) => candidate.playerId === playerId);
    if (state.status !== "playing" || !slot || slot.isSpectator || !slot.positionId) return;
    enteredGameRef.current = true;
    onReady({
      ws: socket,
      sendRoomAction: (type, payload) => socket.send(JSON.stringify({ type, payload })),
      playerId,
      roomCode: state.roomCode,
      reconnectToken: token,
      myPositionIds: slot.positionIds.length > 0 ? slot.positionIds : [slot.positionId],
      isHost: slot.isHost,
      initialGameState: state.gameState,
    });
  }

  function connect(serverUrl: string, resumeToken?: string) {
    setStep("connecting");
    setError("");
    connectingRef.current = true;

    const socket = new WebSocket(serverUrl);
    let connectedPlayerId = "";
    let connectedToken = "";
    setWs(socket);

    socket.onopen = () => {
      if (mode === "create") {
        socket.send(JSON.stringify({
          type: "create-room",
          payload: { mode: gameMode, displayName: displayName || "Player" },
        }));
      } else {
        socket.send(JSON.stringify({
          type: "join-room",
          payload: { roomCode: roomCode.toUpperCase(), displayName: displayName || "Player", reconnectToken: resumeToken },
        }));
      }
    };

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "welcome") {
        connectingRef.current = false;
        connectedPlayerId = String(msg.payload.playerId);
        connectedToken = String(msg.payload.reconnectToken || "");
        setMyPlayerId(msg.payload.playerId);
        setReconnectToken(connectedToken);
        try { sessionStorage.setItem("pass-playerId", msg.payload.playerId); } catch { /* */ }
        try { sessionStorage.setItem("pass-roomCode", msg.payload.roomCode); } catch { /* */ }
        try { sessionStorage.setItem("pass-reconnectToken", connectedToken); } catch { /* */ }
        try { sessionStorage.setItem("pass-displayName", displayName); } catch { /* */ }
      } else if (msg.type === "room-state") {
        setRoomState(msg.payload);
        enterGame(socket, msg.payload as RoomState, connectedPlayerId, connectedToken);
      } else if (msg.type === "error") {
        connectingRef.current = false;
        setError(msg.payload.message || "出错了");
        // Only go back to input if we haven't joined a room yet
        if (!roomState) {
          setStep("input");
          socket.close();
        }
      }
    };

    socket.onclose = () => {
      if (connectingRef.current) {
        connectingRef.current = false;
        setError("无法连接到服务器，请检查网络。");
        setStep("input");
      }
    };

    socket.onerror = () => {
      // Error handling via onclose
    };
  }

  useEffect(() => {
    if (mode !== "join" || !initialCode) return;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const savedRoom = sessionStorage.getItem("pass-roomCode");
      const savedToken = sessionStorage.getItem("pass-reconnectToken");
      if (savedRoom === initialCode.toUpperCase() && savedToken) {
        resumeTimer = setTimeout(() => connect(getWsUrl(), savedToken), 0);
      }
    } catch { /* storage unavailable */ }
    return () => { if (resumeTimer) clearTimeout(resumeTimer); };
    // Resume is intentionally attempted only once for the URL loaded by the browser.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleCreate(serverUrl: string) {
    connect(serverUrl);
  }

  function handleJoin(serverUrl: string) {
    connect(serverUrl);
  }

  function handleChooseSlot(positionId: string) {
    ws?.send(JSON.stringify({
      type: "choose-slot",
      payload: { positionId },
    }));
  }

  function handleToggleReady() {
    ws?.send(JSON.stringify({ type: "toggle-ready", payload: {} }));
  }

  function handleStartGame() {
    ws?.send(JSON.stringify({ type: "start-game", payload: {} }));
  }

  function handleEnterGame() {
    if (ws && myPlayerId && roomState) {
      const slot = roomState.slots.find((s) => s.playerId === myPlayerId);
      onReady({
        ws,
        sendRoomAction: (type, payload) => ws.send(JSON.stringify({ type, payload })),
        playerId: myPlayerId,
        roomCode: roomState.roomCode,
        reconnectToken,
        myPositionIds: slot?.positionIds?.length ? slot.positionIds : slot?.positionId ? [slot.positionId] : [],
        isHost: slot?.isHost ?? false,
        initialGameState: roomState.gameState,
      });
    }
  }

  const inviteUrl = roomState
    ? `${window.location.origin}${window.location.pathname}?room=${roomState.roomCode}`
    : "";

  function copyRoomLink(code: string) {
    const url = `${window.location.origin}${window.location.pathname}?room=${code}`;
    try {
      // Try modern clipboard API first
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(url).then(
          () => alert("房间链接已复制！\n" + url),
          () => fallbackCopy(url),
        );
      } else {
        fallbackCopy(url);
      }
    } catch {
      fallbackCopy(url);
    }
  }

  function fallbackCopy(text: string) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); alert("房间链接已复制！\n" + text); } catch { alert("请手动复制链接：\n" + text); }
    document.body.removeChild(ta);
  }

  // Input form (no roomState needed)
  if (step === "input") {
    return (
      <div className="lobby-panel">
        <div className="lobby-card">
          <div className="brand-block">
            <div className="brand-mark">P</div>
            <div>
              <p className="kicker">TACTICAL FOOTBALL CARD GAME</p>
              <h1>PASS 联机版</h1>
            </div>
          </div>

          <div className="lobby-form">
            {mode === "create" ? (
              <>
                <h2>创建房间</h2>
                <div className="form-group">
                  <label>你的名字</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value.slice(0, 20))}
                    placeholder="输入昵称"
                    maxLength={20}
                  />
                </div>
                <div className="form-group">
                  <label>游戏模式</label>
                  <div className="mode-selector">
                    <button
                      className={gameMode === "3v3-duel" ? "active" : ""}
                      onClick={() => setGameMode("3v3-duel")}
                    >
                      3v3 双人整队
                      <small>2 人 · 各控制一队</small>
                    </button>
                    <button
                      className={gameMode === "4v4-duo" ? "active" : ""}
                      onClick={() => setGameMode("4v4-duo")}
                    >
                      4v4 四人搭档
                      <small>4 人 · 每人控制两名</small>
                    </button>
                    <button
                      className={gameMode === "1v1" ? "active" : ""}
                      onClick={() => setGameMode("1v1")}
                    >
                      1v1（2人）
                    </button>
                    <button
                      className={gameMode === "2v2" ? "active" : ""}
                      onClick={() => setGameMode("2v2")}
                    >
                      2v2（4人）
                    </button>
                    <button
                      className={gameMode === "3v3" ? "active" : ""}
                      onClick={() => setGameMode("3v3")}
                    >
                      3v3 传统（6人）
                    </button>
                    <button
                      className={gameMode === "4v4" ? "active" : ""}
                      onClick={() => setGameMode("4v4")}
                    >
                      4v4 传统（8人）
                    </button>
                  </div>
                </div>
                <button
                  className="primary-action full"
                  disabled={!displayName.trim()}
                  onClick={() => handleCreate(getWsUrl())}
                >
                  创建房间
                </button>
                <a className="quiet-button" href="?singleplayer=1">试玩人机模式</a>
              </>
            ) : (
              <>
                <h2>加入房间</h2>
                <div className="form-group">
                  <label>你的名字</label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value.slice(0, 20))}
                    placeholder="输入昵称"
                    maxLength={20}
                  />
                </div>
                <div className="form-group">
                  <label>房间码</label>
                  <input
                    type="text"
                    value={roomCode}
                    onChange={(e) => setRoomCode(e.target.value.toUpperCase().slice(0, 6))}
                    placeholder="输入6位大写字母"
                    maxLength={6}
                    className="room-code-input"
                  />
                </div>
                <button
                  className="primary-action full"
                  disabled={!displayName.trim() || roomCode.length < 6}
                  onClick={() => handleJoin(getWsUrl())}
                >
                  加入房间
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Loading state while waiting for room data
  if (!roomState || !myPlayerId) {
    return (
      <div className="lobby-panel">
        <div className="lobby-card" style={{ textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 14, color: "#5c625e" }}>正在连接房间...</p>
          {error && <p className="lobby-error">{error}</p>}
        </div>
      </div>
    );
  }

  // Derived from roomState (safe — roomState is non-null below)
  const mySlot = roomState.slots.find((s) => s.playerId === myPlayerId);
  const isHost = mySlot?.isHost ?? false;
  const activeSlots = roomState.slots.filter((s) => !s.isSpectator);
  const requiredPlayers = roomState.gameMode === "3v3-duel" || roomState.gameMode === "4v4-duo"
    ? roomState.playerSlotsPerTeam * 2
    : 2;
  const allReady = activeSlots.length >= requiredPlayers && activeSlots.every((s) => s.isReady);
  const spectatorSlots = roomState.slots.filter((s) => s.isSpectator);

  // If game has started, show transition
  if (roomState.status === "playing" && !mySlot?.isSpectator) {
    return (
      <div className="lobby-panel">
        <div className="lobby-card">
          <h2>游戏开始！</h2>
          <p>正在进入对局...</p>
          <button className="primary-action" onClick={handleEnterGame}>进入游戏</button>
        </div>
      </div>
    );
  }

  if (roomState.status === "playing" && mySlot?.isSpectator) {
    return (
      <div className="lobby-panel">
        <div className="lobby-card spectator-banner">
          <h2>观战中</h2>
          <p>你正在观看房间 {roomState.roomCode} 的比赛。</p>
        </div>
      </div>
    );
  }

  // Lobby room view
  return (
    <div className="lobby-panel">
      <div className="lobby-card wide">
        <div className="lobby-header">
          <div>
            <h2>房间 {roomState.roomCode}</h2>
            <span className="mode-badge">{ROOM_MODE_LABELS[roomState.gameMode]}</span>
          </div>
          <button className="quiet-button" onClick={() => copyRoomLink(roomState.roomCode)}>
            复制邀请链接
          </button>
        </div>

        <p className="lobby-hint">选择你的位置并准备。房主在所有玩家准备后即可开始游戏。</p>

        <div className="invite-bar">
          <input
            type="text"
            className="invite-url"
            readOnly
            value={inviteUrl}
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <button className="primary-action" onClick={() => copyRoomLink(roomState.roomCode)}>
            复制链接
          </button>
        </div>

        <div className="slot-grid">
          {/* Red team */}
          <div className="team-section red">
            <h3>红队 (RED)</h3>
            {Array.from({ length: roomState.playerSlotsPerTeam }, (_, i) => {
              const posId = `r${i + 1}`;
              const slot = activeSlots.find((s) => s.positionId === posId);
              return (
                <div
                  key={posId}
                  className={`slot-card red ${slot ? "taken" : "empty"} ${slot?.playerId === myPlayerId ? "mine" : ""} ${slot?.isReady ? "ready" : ""}`}
                  onClick={() => !slot && mySlot && !mySlot.positionId && handleChooseSlot(posId)}
                >
                  <span className="slot-pos">{controllerSeatLabel(roomState.gameMode, "red", i)}</span>
                  {slot ? (
                    <>
                      <span className="slot-name">{slot.displayName}{slot.isHost ? " (房主)" : ""}</span>
                      <span className={`slot-status ${slot.isReady ? "ready" : ""}`}>
                        {slot.isReady ? "已准备" : "未准备"}
                      </span>
                    </>
                  ) : (
                    <span className="slot-available">可选</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Blue team */}
          <div className="team-section blue">
            <h3>蓝队 (BLUE)</h3>
            {Array.from({ length: roomState.playerSlotsPerTeam }, (_, i) => {
              const posId = `b${i + 1}`;
              const slot = activeSlots.find((s) => s.positionId === posId);
              return (
                <div
                  key={posId}
                  className={`slot-card blue ${slot ? "taken" : "empty"} ${slot?.playerId === myPlayerId ? "mine" : ""} ${slot?.isReady ? "ready" : ""}`}
                  onClick={() => !slot && mySlot && !mySlot.positionId && handleChooseSlot(posId)}
                >
                  <span className="slot-pos">{controllerSeatLabel(roomState.gameMode, "blue", i)}</span>
                  {slot ? (
                    <>
                      <span className="slot-name">{slot.displayName}{slot.isHost ? " (房主)" : ""}</span>
                      <span className={`slot-status ${slot.isReady ? "ready" : ""}`}>
                        {slot.isReady ? "已准备" : "未准备"}
                      </span>
                    </>
                  ) : (
                    <span className="slot-available">可选</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {spectatorSlots.length > 0 && (
          <div className="spectator-list">
            <h4>观众 ({spectatorSlots.length})</h4>
            {spectatorSlots.map((s) => (
              <span key={s.playerId} className="spectator-name">{s.displayName}</span>
            ))}
          </div>
        )}

        {error && <p className="lobby-error">{error}</p>}

        <div className="lobby-actions">
          {mySlot && !mySlot.isSpectator && (
            <button
              className="secondary-action"
              onClick={handleToggleReady}
            >
              {mySlot.isReady ? "取消准备" : "准备"}
            </button>
          )}
          {isHost && (
            <button
              className="primary-action"
              disabled={!allReady || activeSlots.length < 2}
              onClick={handleStartGame}
            >
              开始游戏
            </button>
          )}
          {!isHost && !mySlot?.isSpectator && (
            <p className="waiting-text">等待房主开始游戏...</p>
          )}
        </div>
      </div>
    </div>
  );
}
