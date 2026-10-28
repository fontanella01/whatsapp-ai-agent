import { useEffect, useRef } from "react";
import { tokenStore, type LiveEvent } from "./api";

// Subscribes to the server's live event stream (SSE) while the component is mounted.
// The browser reconnects on its own if the connection drops.
export function useLiveEvents(onEvent: (e: LiveEvent) => void) {
  // always call the latest handler without reconnecting on every render
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const token = tokenStore.get();
    if (!token) return;
    const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    source.onmessage = (msg) => {
      try {
        handler.current(JSON.parse(msg.data) as LiveEvent);
      } catch {
        // ignore malformed events
      }
    };
    return () => source.close();
  }, []);
}
