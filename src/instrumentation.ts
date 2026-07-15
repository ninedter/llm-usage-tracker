// Next.js instrumentation hook — runs once when the server process boots, in
// both the Electron-wrapped standalone server and the Docker container.
//
// This is what makes Codex/OpenAI activity show up at all: it backfills recent
// ~/.codex rollout logs, then tails them for new events. The Claude watcher is
// its token-only twin: hooks already stream Claude sessions/events live, but
// only the ~/.claude/projects transcripts know the per-model token counts.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // skip edge/browser runtimes

  const { startCodexWatcher } = await import("@/lib/providers/codex-watcher");
  startCodexWatcher();

  const { startClaudeUsageWatcher } = await import("@/lib/providers/claude-watcher");
  startClaudeUsageWatcher();
}
