// Broadcast system using in-memory event emitter
// The actual transport to the browser is SSE (Server-Sent Events)

type WsEventType =
  | "agent_created"
  | "agent_updated"
  | "event_created"
  | "session_created"
  | "session_updated"
  | "stats_updated";

type WsEvent = {
  type: WsEventType;
  data: unknown;
};

type Listener = (event: WsEvent) => void;

const listeners = new Set<Listener>();

export function broadcastEvent(event: WsEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // ignore listener errors
    }
  }
}

export function addListener(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getListenerCount(): number {
  return listeners.size;
}
