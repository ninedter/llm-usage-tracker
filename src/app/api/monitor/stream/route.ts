import { addListener } from "@/lib/ws";

// Force dynamic rendering — SSE streams can't be static
export const dynamic = "force-dynamic";

// GET /api/monitor/stream — SSE endpoint for real-time agent updates
export async function GET(): Promise<Response> {
  const encoder = new TextEncoder();

  let cleanupFn: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      // Send initial heartbeat
      controller.enqueue(encoder.encode("event: connected\ndata: {}\n\n"));

      // Subscribe to broadcast events
      const unsubscribe = addListener((frame) => {
        try {
          controller.enqueue(frame);
        } catch {
          // controller may be closed
        }
      });

      // Heartbeat every 30s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 30_000);

      cleanupFn = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
    },
    cancel() {
      cleanupFn?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
