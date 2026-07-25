"use client";

interface Props {
  visible: boolean;
  message?: string;
  onRetry: () => void;
}

export default function ReconnectOverlay({ visible, message, onRetry }: Props) {
  if (!visible) return null;

  return (
    <div className="reconnect-overlay">
      <div className="reconnect-card">
        <div className="reconnect-spinner" />
        <h2>连接中断</h2>
        <p>{message || "正在尝试重新连接..."}</p>
        <button className="primary-action" onClick={onRetry}>
          手动重连
        </button>
      </div>
    </div>
  );
}
