// Next.js instrumentation hook — runs once when the server process boots, in
// both the Electron-wrapped standalone server and the Docker container.
//
// This is what makes Codex/OpenAI activity show up at all: it backfills recent
// ~/.codex rollout logs, then tails them for new events.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // skip edge/browser runtimes

  const { startCodexWatcher } = await import("@/lib/providers/codex-watcher");
  startCodexWatcher();
}
