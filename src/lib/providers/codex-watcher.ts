import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import { ingestRolloutFile, closeIdleCodexSessions } from "@/lib/providers/codex-ingest";
import { broadcastEvent } from "@/lib/ws";

const DAY = 86400000;
const DEFAULT_INTERVAL_MS = 4000;
const DEFAULT_BACKFILL_DAYS = 90;

/**
 * Codex CLI's home (CODEX_HOME, else ~/.codex). Returns null when there are no
 * rollout logs to read — the app simply runs without Codex tracking, the same
 * way OpenAIClient.readCodexAuth() degrades when the user never ran `codex`.
 * In Docker the host's ~/.codex is bind-mounted read-only; we never write to it.
 */
export function codexHome(): string | null {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  return existsSync(join(home, "sessions")) ? home : null;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir — skip rather than fail the sweep
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

// rollout-2026-07-14T06-11-23-<uuid>.jsonl → epoch ms for 2026-07-14
function dateFromName(name: string): number | null {
  const m = name.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T/);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`) : null;
}

/**
 * Rollout files worth looking at: those dated within the window, plus any file
 * recently modified (an old-named session that is still being appended to).
 */
export function discoverRolloutFiles(sessionsDir: string, sinceMs: number): string[] {
  return walk(sessionsDir)
    .filter((f) => {
      const named = dateFromName(basename(f));
      if (named !== null && named >= sinceMs - DAY) return true;
      try {
        return statSync(f).mtimeMs >= sinceMs;
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * One sweep: ingest anything new in every in-window rollout file, then retire
 * sessions whose logs have gone quiet.
 *
 * `broadcast` is off for the initial backfill on purpose — pushing 37k historic
 * events down the SSE channel would swamp the live Activity feed (and the
 * browser) with months-old history pretending to be happening now.
 */
export function pollOnce(sessionsDir: string, sinceMs = 0, opts?: { broadcast?: boolean }): number {
  const broadcast = opts?.broadcast ?? false;

  let inserted = 0;
  for (const file of discoverRolloutFiles(sessionsDir, sinceMs)) {
    try {
      const res = ingestRolloutFile(
        file,
        broadcast ? (e) => broadcastEvent({ type: "event_created", data: e }) : undefined
      );
      inserted += res.inserted;
    } catch (err) {
      // One bad file must never stall the sweep or take the server down.
      console.error(`[codex-watcher] ingest failed for ${file}:`, err);
    }
  }

  try {
    const closed = closeIdleCodexSessions();
    if (closed > 0 && broadcast) broadcastEvent({ type: "stats_updated", data: { closed } });
  } catch (err) {
    console.error("[codex-watcher] closing idle sessions failed:", err);
  }

  return inserted;
}

/**
 * Backfill the last N days, then tail for new bytes on an interval.
 *
 * Polling (not fs.watch) is deliberate: fs.watch doesn't reliably deliver
 * events for Docker bind-mounts of macOS host dirs, so a single polling path
 * is what makes this work identically under Electron and Docker.
 */
export function startCodexWatcher(opts?: { intervalMs?: number; backfillDays?: number }): () => void {
  const home = codexHome();
  if (!home) {
    console.log("[codex-watcher] no ~/.codex/sessions — Codex tracking disabled");
    return () => {};
  }

  const sessionsDir = join(home, "sessions");
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const backfillDays = opts?.backfillDays ?? DEFAULT_BACKFILL_DAYS;
  const since = Date.now() - backfillDays * DAY;

  try {
    const t0 = Date.now();
    const n = pollOnce(sessionsDir, since, { broadcast: false }); // history is not "live"
    console.log(`[codex-watcher] backfill: ${n} new events from the last ${backfillDays}d (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error("[codex-watcher] backfill failed:", err);
  }

  let running = false;
  const timer = setInterval(() => {
    if (running) return; // a slow sweep must not overlap itself
    running = true;
    try {
      pollOnce(sessionsDir, since, { broadcast: true }); // from here on, events really are live
    } catch (err) {
      console.error("[codex-watcher] poll failed:", err);
    } finally {
      running = false;
    }
  }, intervalMs);

  timer.unref?.(); // never hold the process open

  return () => clearInterval(timer);
}
