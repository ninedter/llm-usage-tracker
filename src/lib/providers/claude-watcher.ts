import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { createSession, getCodexIngest, getSession, upsertCodexIngest, upsertTokenUsage } from "@/lib/db";
import { aggregateGroupUsage, parseClaudeTranscript, type TranscriptScan } from "@/lib/providers/claude-transcript";

const DAY = 86400000;
// Token totals feed the (60s-polling) analytics page, not the live monitor, so
// this can tick far slower than the codex watcher's 4s event tail.
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BACKFILL_DAYS = 90;
// Mirrors codex-ingest's LIVE_WINDOW_MS: a transcript quiet this long is done.
const LIVE_WINDOW_MS = 5 * 60_000;

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GroupFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/** One Claude Code session's transcript set: main file + subagent files. */
export interface SessionGroup {
  sessionId: string;
  files: GroupFile[];
  lastMtimeMs: number;
}

/**
 * Claude Code's transcript root (CLAUDE_PROJECTS_DIR, else ~/.claude/projects).
 * Null when absent — the app runs without Claude token tracking, exactly like
 * codexHome() degrading when the user never ran `codex`. In Docker the host
 * dir is bind-mounted read-only; we never write to it.
 */
export function claudeProjectsDir(): string | null {
  const dir = process.env.CLAUDE_PROJECTS_DIR || join(homedir(), ".claude", "projects");
  return existsSync(dir) ? dir : null;
}

function statFile(path: string): GroupFile | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { path, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null; // deleted between readdir and stat — skip
  }
}

function walkJsonl(dir: string): GroupFile[] {
  const out: GroupFile[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir — skip rather than fail the sweep
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJsonl(full));
    else if (e.isFile() && e.name.endsWith(".jsonl")) {
      const f = statFile(full);
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * Group every transcript under its session: `<uuid>.jsonl` plus everything in
 * `<uuid>/` (subagent + workflow logs — their lines all carry the parent's
 * sessionId). Groups whose newest member predates `sinceMs` are skipped.
 * A `<uuid>/` dir without its main file still forms a group: Claude Code's
 * cleanup can remove the parent first, and the dir name alone names the session.
 */
export function discoverSessionGroups(projectsDir: string, sinceMs: number): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  let projectDirs;
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const proj of projectDirs) {
    if (!proj.isDirectory()) continue;
    const projPath = join(projectsDir, proj.name);
    let entries;
    try {
      entries = readdirSync(projPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      let sessionId: string | null = null;
      let files: GroupFile[] = [];

      if (e.isFile() && SESSION_FILE_RE.test(e.name)) {
        sessionId = e.name.slice(0, -".jsonl".length).toLowerCase();
        const f = statFile(join(projPath, e.name));
        if (f) files = [f];
      } else if (e.isDirectory() && UUID_DIR_RE.test(e.name)) {
        sessionId = e.name.toLowerCase();
        files = walkJsonl(join(projPath, e.name));
      }

      if (!sessionId || files.length === 0) continue;
      const existing = groups.get(sessionId);
      if (existing) {
        existing.files.push(...files);
        existing.lastMtimeMs = Math.max(existing.lastMtimeMs, ...files.map((f) => f.mtimeMs));
      } else {
        groups.set(sessionId, {
          sessionId,
          files,
          lastMtimeMs: Math.max(...files.map((f) => f.mtimeMs)),
        });
      }
    }
  }

  return [...groups.values()].filter((g) => g.lastMtimeMs >= sinceMs);
}

// A group needs recomputing when any member is new or has different bytes than
// the cursor recorded. Cursor rows live in codex_ingest (a generic per-file
// tail table despite the name): byte_offset = size processed, last_seen_at =
// mtime processed, thread_id = the owning session.
function groupIsDirty(group: SessionGroup): boolean {
  for (const f of group.files) {
    const cursor = getCodexIngest(f.path);
    if (!cursor || cursor.byte_offset !== f.size || cursor.last_seen_at !== f.mtimeMs) return true;
  }
  return false;
}

/**
 * Re-derive one session's token totals from its complete transcript set and
 * REPLACE-upsert them. Absolute recompute (vs byte tailing à la codex) is what
 * keeps message-id dedup exact when a streaming message's lines straddle two
 * sweeps — and transcript files are small enough (p99 ≈ 5 MB here) that a full
 * re-read on change is cheap.
 */
export function recomputeSessionGroup(group: SessionGroup): number {
  const scans: TranscriptScan[] = [];
  for (const f of group.files) {
    try {
      scans.push(parseClaudeTranscript(readFileSync(f.path, "utf8")));
    } catch (err) {
      console.error(`[claude-watcher] read failed for ${f.path}:`, err);
    }
  }

  const totals = aggregateGroupUsage(group.sessionId, scans);

  if (totals.length > 0) {
    // Pre-tracker history: transcripts for sessions the hooks never saw still
    // need a sessions row, or the token_usage join hides their usage. Hook-born
    // sessions are left untouched (INSERT OR IGNORE inside createSession).
    if (!getSession(group.sessionId)) {
      const meta = scans.find((s) => s.cwd) ?? scans[0];
      const firstTs = Math.min(...scans.map((s) => s.firstTs ?? Infinity));
      const lastTs = Math.max(...scans.map((s) => s.lastTs ?? 0), group.lastMtimeMs);
      createSession(
        {
          id: group.sessionId,
          status: "completed",
          project: meta?.cwd ? basename(meta.cwd) : "",
          cwd: meta?.cwd ?? "",
          entrypoint: meta?.entrypoint ?? "cli",
          started_at: Number.isFinite(firstTs) ? firstTs : group.lastMtimeMs,
          ended_at: lastTs,
          metadata: JSON.stringify({ transcript_backfill: true }),
        },
        "anthropic"
      );
    }

    const now = Date.now();
    for (const t of totals) {
      upsertTokenUsage(
        {
          session_id: group.sessionId,
          model: t.model,
          input_tokens: t.input_tokens,
          output_tokens: t.output_tokens,
          cache_read_tokens: t.cache_read_tokens,
          cache_write_tokens: t.cache_write_tokens,
          cost: 0, // Claude Code runs on a flat subscription — a dollar figure would be fiction
          updated_at: now,
        },
        "anthropic"
      );
    }
  }

  const isLive = Date.now() - group.lastMtimeMs < LIVE_WINDOW_MS;
  for (const f of group.files) {
    upsertCodexIngest({
      file_path: f.path,
      byte_offset: f.size,
      thread_id: group.sessionId,
      last_seen_at: f.mtimeMs,
      status: isLive ? "active" : "done",
    });
  }

  return totals.length;
}

/** One sweep: recompute every session group with changed transcript bytes. */
export function pollClaudeUsageOnce(projectsDir: string, sinceMs = 0): number {
  let updated = 0;
  for (const group of discoverSessionGroups(projectsDir, sinceMs)) {
    try {
      if (!groupIsDirty(group)) continue;
      recomputeSessionGroup(group);
      updated++;
    } catch (err) {
      // One bad session must never stall the sweep or take the server down.
      console.error(`[claude-watcher] recompute failed for ${group.sessionId}:`, err);
    }
  }
  return updated;
}

/**
 * Backfill recent transcript history, then poll for growth on an interval.
 *
 * Polling (not fs.watch) is deliberate, same as the codex watcher: fs.watch
 * doesn't reliably deliver events for Docker bind-mounts of macOS host dirs.
 * The backfill is deferred off the boot path so /api/live health probes never
 * wait on a first-run parse of months of transcripts.
 */
export function startClaudeUsageWatcher(opts?: { intervalMs?: number; backfillDays?: number }): () => void {
  const dir = claudeProjectsDir();
  if (!dir) {
    console.log("[claude-watcher] no Claude projects dir — Claude token tracking disabled");
    return () => {};
  }

  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const backfillDays = opts?.backfillDays ?? DEFAULT_BACKFILL_DAYS;
  const since = Date.now() - backfillDays * DAY;

  let running = false;
  const sweep = (label: string) => {
    if (running) return; // a slow sweep must not overlap itself
    running = true;
    try {
      const t0 = Date.now();
      const n = pollClaudeUsageOnce(dir, since);
      if (n > 0 && label === "backfill") {
        console.log(`[claude-watcher] backfill: token totals for ${n} sessions from the last ${backfillDays}d (${Date.now() - t0}ms)`);
      }
    } catch (err) {
      console.error(`[claude-watcher] ${label} failed:`, err);
    } finally {
      running = false;
    }
  };

  const backfillTimer = setTimeout(() => sweep("backfill"), 2_000);
  backfillTimer.unref?.();

  const timer = setInterval(() => sweep("poll"), intervalMs);
  timer.unref?.(); // never hold the process open

  return () => {
    clearTimeout(backfillTimer);
    clearInterval(timer);
  };
}
