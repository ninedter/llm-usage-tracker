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

type Listener = (frame: Uint8Array) => void;

const listeners = new Set<Listener>();
const encoder = new TextEncoder();

export function broadcastEvent(event: WsEvent): void {
  if (listeners.size === 0) return; // nobody connected — skip the stringify entirely
  const frame = encoder.encode(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
  for (const listener of listeners) {
    try {
      listener(frame);
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
