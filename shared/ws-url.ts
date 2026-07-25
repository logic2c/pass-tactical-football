/** Get WebSocket URL for connecting to the game server. */
export function getWsUrl(): string {
  // Allow explicit override via env var (e.g. for local dev)
  if (process.env.NEXT_PUBLIC_WS_URL) {
    return process.env.NEXT_PUBLIC_WS_URL;
  }
  // In production, connect to same host via /ws path (nginx proxy)
  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}/ws`;
  }
  // SSR fallback
  return "ws://localhost:8080";
}
