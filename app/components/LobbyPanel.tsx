"use client";

import { useState } from "react";
import type { PlayerSlot, RoomState } from "@/shared/types";
import { getWsUrl } from "@/shared/ws-url";

type Props = {
  mode: "create" | "join";
  initialCode?: string;
  onReady: (transport: {
    ws: WebSocket;
    sendRoomAction: (type: string, payload: unknown) => void;
    playerId: string;
    roomCode: string;
  }) => void;
};

export default function LobbyPanel({ mode, initialCode, onReady }: Props) {
  const [displayName, setDisplayName] = useState("");
  const [roomCode, setRoomCode] = useState(initialCode || "");
  const [gameMode, setGameMode] = useState<"3v3" | "4v4">("3v3");
  const [step, setStep] = useState<"input" | "connecting">("input");
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [myPlayerId, setMyPlayerId] = useState("");
  const [ws, setWs] = useState<WebSocket | null>(null);
  const [error, setError] = useState("");

  function connect(serverUrl: string) {
    setStep("connecting");
    setError("");

    const socket = new WebSocket(serverUrl);
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
          payload: { roomCode: roomCode.toUpperCase(), displayName: displayName || "Player" },
        }));
      }
    };

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "welcome") {
        setMyPlayerId(msg.payload.playerId);
        // Store playerId for reconnection
        try { sessionStorage.setItem("pass-playerId", msg.payload.playerId); } catch { /* */ }
        try { sessionStorage.setItem("pass-roomCode", msg.payload.roomCode); } catch { /* */ }
      } else if (msg.type === "room-state") {
        setRoomState(msg.payload);
      } else if (msg.type === "error") {
        setError(msg.payload.message || "出错了");
        setStep("input");
        socket.close();
      }
    };

    socket.onclose = () => {
      if (step === "connecting") {
        setError("无法连接到服务器。");
        setStep("input");
      }
    };

    socket.onerror = () => {
      // Error handling via onclose
    };
  }

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
      onReady({
        ws,
        sendRoomAction: (type, payload) => ws.send(JSON.stringify({ type, payload })),
        playerId: myPlayerId,
        roomCode: roomState.roomCode,
      });
    }
  }

  const mySlot = roomState?.slots.find((s) => s.playerId === myPlayerId);
  const isHost = mySlot?.isHost ?? false;
  const allReady = roomState?.slots.filter((s) => !s.isSpectator).every((s) => s.isReady) ?? false;
  const activeSlots = roomState?.slots.filter((s) => !s.isSpectator) ?? [];
  const spectatorSlots = roomState?.slots.filter((s) => s.isSpectator) ?? [];

  // If game has started, show transition
  if (roomState?.status === "playing" && !mySlot?.isSpectator) {
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

  if (roomState?.status === "playing" && mySlot?.isSpectator) {
    return (
      <div className="lobby-panel">
        <div className="lobby-card spectator-banner">
          <h2>观战中</h2>
          <p>你正在观看房间 {roomState.roomCode} 的比赛。</p>
        </div>
      </div>
    );
  }

  // Input form
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
                      className={gameMode === "3v3" ? "active" : ""}
                      onClick={() => setGameMode("3v3")}
                    >
                      3v3（6人）
                    </button>
                    <button
                      className={gameMode === "4v4" ? "active" : ""}
                      onClick={() => setGameMode("4v4")}
                    >
                      4v4（8人）
                    </button>
                  </div>
                </div>
                <button
                  className="primary-action full"
                  onClick={() => handleCreate(getWsUrl())}
                >
                  创建房间
                </button>
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
                  disabled={roomCode.length < 6}
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

  // Lobby room view
  return (
    <div className="lobby-panel">
      <div className="lobby-card wide">
        <div className="lobby-header">
          <div>
            <h2>房间 {roomState?.roomCode}</h2>
            <span className="mode-badge">{roomState?.gameMode === "4v4" ? "4v4" : "3v3"}</span>
          </div>
          <button
            className="quiet-button"
            onClick={() => {
              const url = `${window.location.origin}${window.location.pathname}?room=${roomState?.roomCode}`;
              navigator.clipboard.writeText(url).then(() => alert("房间链接已复制！"));
            }}
          >
            复制邀请链接
          </button>
        </div>

        <p className="lobby-hint">选择你的位置并准备。房主在所有玩家准备后即可开始游戏。</p>

        <div className="slot-grid">
          {/* Red team */}
          <div className="team-section red">
            <h3>红队 (RED)</h3>
            {Array.from({ length: roomState?.playerSlotsPerTeam ?? 3 }, (_, i) => {
              const posId = `r${i + 1}`;
              const slot = activeSlots.find((s) => s.positionId === posId);
              return (
                <div
                  key={posId}
                  className={`slot-card red ${slot ? "taken" : "empty"} ${slot?.playerId === myPlayerId ? "mine" : ""} ${slot?.isReady ? "ready" : ""}`}
                  onClick={() => !slot && mySlot && !mySlot.positionId && handleChooseSlot(posId)}
                >
                  <span className="slot-pos">{posId.toUpperCase()}</span>
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
            {Array.from({ length: roomState?.playerSlotsPerTeam ?? 3 }, (_, i) => {
              const posId = `b${i + 1}`;
              const slot = activeSlots.find((s) => s.positionId === posId);
              return (
                <div
                  key={posId}
                  className={`slot-card blue ${slot ? "taken" : "empty"} ${slot?.playerId === myPlayerId ? "mine" : ""} ${slot?.isReady ? "ready" : ""}`}
                  onClick={() => !slot && mySlot && !mySlot.positionId && handleChooseSlot(posId)}
                >
                  <span className="slot-pos">{posId.toUpperCase()}</span>
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
