// Parser for Claude Code transcript JSONL files (~/.claude/projects/**).
//
// This is the Claude twin of codex-rollout.ts, but for token usage only:
// sessions/agents/events already arrive live through the hook pipeline, so all
// the analytics are missing is the per-model token counts that hooks never
// carry. Those live in the transcripts, one `message.usage` per assistant API
// response.
//
// Layout on disk (one session = one group of files):
//   <projects>/<project-slug>/<session-uuid>.jsonl          — main transcript
//   <projects>/<project-slug>/<session-uuid>/subagents/**   — Task/workflow
//     agent transcripts; every line carries the PARENT session's sessionId
//
// Parsing model: a message streams as several JSONL lines sharing one
// message.id, each repeating that response's usage object — so usage is
// deduped per message.id (last line wins) before summing. Totals are absolute
// per (session, model), matching upsertTokenUsage's REPLACE semantics: the
// caller re-parses a whole session group and overwrites, which makes ingestion
// idempotent and self-healing by construction.

export interface TranscriptUsageEntry {
  sessionId: string;
  messageId: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  timestamp: number;
}

export interface TranscriptScan {
  entries: TranscriptUsageEntry[];
  /** First sessionId seen on any usage line (files carry exactly one). */
  sessionId: string | null;
  cwd: string | null;
  entrypoint: string | null;
  firstTs: number | null;
  lastTs: number | null;
}

export interface ModelTotals {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  lastTs: number;
}

// Claude Code writes placeholder assistant messages (API errors, aborts) under
// this pseudo-model; they carry no real usage and must not become a model row.
const SYNTHETIC_MODEL = "<synthetic>";

// Cheap gate before JSON.parse: only assistant lines can carry usage, and the
// bulky lines (tool results embedded in user messages) are exactly the ones
// this skips. False positives just cost one parse; the strings below cover
// both compact and pretty-ish encoders.
function looksLikeAssistantLine(line: string): boolean {
  return line.includes('"type":"assistant"') || line.includes('"type": "assistant"');
}

/**
 * Extract every usage-bearing assistant entry from one transcript's text.
 * Malformed lines (half-written tails, junk) are skipped, never thrown on.
 */
export function parseClaudeTranscript(text: string): TranscriptScan {
  const scan: TranscriptScan = {
    entries: [],
    sessionId: null,
    cwd: null,
    entrypoint: null,
    firstTs: null,
    lastTs: null,
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || !looksLikeAssistantLine(line)) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // half-written or corrupt line — next sweep will see it whole
    }
    if (obj?.type !== "assistant") continue;

    const message = obj.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    const model = typeof message?.model === "string" ? message.model : null;
    const messageId = typeof message?.id === "string" ? message.id : null;
    const sessionId = typeof obj.sessionId === "string" ? obj.sessionId : null;
    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;

    if (sessionId && !scan.sessionId) scan.sessionId = sessionId;
    if (typeof obj.cwd === "string" && !scan.cwd) scan.cwd = obj.cwd;
    if (typeof obj.entrypoint === "string" && !scan.entrypoint) scan.entrypoint = obj.entrypoint;
    if (Number.isFinite(ts)) {
      if (scan.firstTs === null || ts < scan.firstTs) scan.firstTs = ts;
      if (scan.lastTs === null || ts > scan.lastTs) scan.lastTs = ts;
    }

    if (!usage || !model || model === SYNTHETIC_MODEL || !messageId || !sessionId) continue;

    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    scan.entries.push({
      sessionId,
      messageId,
      model,
      input_tokens: n(usage.input_tokens),
      output_tokens: n(usage.output_tokens),
      cache_read_tokens: n(usage.cache_read_input_tokens),
      cache_write_tokens: n(usage.cache_creation_input_tokens),
      timestamp: Number.isFinite(ts) ? ts : 0,
    });
  }

  return scan;
}

/**
 * Fold one session group's scans into absolute per-model totals.
 *
 * Entries whose sessionId differs from the group's are dropped: totals are
 * REPLACE-upserted per (session, model), so letting a stray line write into
 * another session's key would clobber that session's real totals.
 */
export function aggregateGroupUsage(sessionId: string, scans: TranscriptScan[]): ModelTotals[] {
  // message.id → entry, last line wins (streaming repeats a message's usage on
  // every content-block line; the final one is authoritative).
  const byMessage = new Map<string, TranscriptUsageEntry>();
  for (const scan of scans) {
    for (const entry of scan.entries) {
      if (entry.sessionId !== sessionId) continue;
      byMessage.set(entry.messageId, entry);
    }
  }

  const byModel = new Map<string, ModelTotals>();
  for (const entry of byMessage.values()) {
    let totals = byModel.get(entry.model);
    if (!totals) {
      totals = { model: entry.model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, lastTs: 0 };
      byModel.set(entry.model, totals);
    }
    totals.input_tokens += entry.input_tokens;
    totals.output_tokens += entry.output_tokens;
    totals.cache_read_tokens += entry.cache_read_tokens;
    totals.cache_write_tokens += entry.cache_write_tokens;
    if (entry.timestamp > totals.lastTs) totals.lastTs = entry.timestamp;
  }

  return [...byModel.values()];
}
