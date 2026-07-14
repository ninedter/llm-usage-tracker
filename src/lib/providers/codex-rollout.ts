import type { AgentEventType } from "@/types";
import { extractExecCommand } from "@/lib/exec-classify";

// Pure mapper for Codex CLI rollout logs (~/.codex/sessions/**/rollout-*.jsonl).
//
// Every line is a JSON record shaped { timestamp: ISO8601, type, payload }.
// Two record streams carry the activity we care about:
//   - event_msg     → mcp_tool_call_end, patch_apply_end, web_search_end,
//                     token_count, context_compacted, task_complete
//   - response_item → custom_tool_call (name="exec") + custom_tool_call_output
//
// Everything here is I/O-free so it can be unit-tested against fixture lines.

export interface CodexMappedEvent {
  event_type: AgentEventType;
  tool_name: string | null;
  summary: string | null;
  content: string | null;
  files_affected: string[];
  timestamp: number; // epoch ms
  source_id: string; // stable across re-reads → drives INSERT OR IGNORE dedup
}

export interface CodexSessionInfo {
  thread_id: string;
  root_id: string; // parent thread for a subagent, else itself
  is_subagent: boolean;
  project: string; // basename(cwd), same rule the Claude hook uses
  cwd: string;
  entrypoint: string; // e.g. "codex-work-desktop"
  description: string;
  started_at: number;
}

export interface CodexTokenTotals {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

interface Rec {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

const asRec = (x: unknown): Rec => (x && typeof x === "object" ? (x as Rec) : {});
const ms = (r: Rec): number => (r.timestamp ? Date.parse(r.timestamp) : 0);
const basename = (p: string): string => p.split("/").filter(Boolean).pop() || p;

export function parseRolloutLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // A truncated or malformed line is skipped rather than failing the file.
    }
  }
  return out;
}

// Latest wall-clock time seen in a chunk, across *all* record types — not just
// the ones we turn into events. This is the session's real last-activity time,
// which is what the monitor's staleness logic has to key off; stamping
// Date.now() would make 90-day-old history look like a live agent.
export function readLastTimestamp(records: unknown[]): number {
  let last = 0;
  for (const raw of records) {
    const t = ms(asRec(raw));
    if (t > last) last = t;
  }
  return last;
}

export function readSessionInfo(records: unknown[]): CodexSessionInfo | null {
  const metaRec = records.map(asRec).find((r) => r.type === "session_meta");
  if (!metaRec) return null;
  const p = metaRec.payload ?? {};

  const thread_id = String(p.id ?? p.session_id ?? "");
  if (!thread_id) return null;

  const subagent = (p.source as { subagent?: { thread_spawn?: Record<string, unknown> } } | undefined)?.subagent;
  const spawn = subagent?.thread_spawn ?? {};
  const is_subagent = p.thread_source === "subagent" || subagent != null;
  const root_id = String(p.parent_thread_id ?? spawn.parent_thread_id ?? thread_id);

  const cwd = String(p.cwd ?? "");
  const originator = String(p.originator ?? "");
  const entrypoint = originator
    ? `codex-${originator.replace(/^codex[_-]?/, "").replace(/_/g, "-")}`
    : "codex";

  const nickname = String(p.agent_nickname ?? spawn.agent_nickname ?? "");
  const agentPath = String(spawn.agent_path ?? "");
  const description = is_subagent
    ? `Codex subagent${nickname ? ` (${nickname})` : ""}${agentPath ? `: ${agentPath}` : ""}`
    : `${basename(cwd) || "codex"} (Codex)`;

  return {
    thread_id,
    root_id,
    is_subagent,
    project: basename(cwd),
    cwd,
    entrypoint,
    description,
    started_at: ms(metaRec),
  };
}

// token_count carries a *cumulative* total, so the last one in a chunk wins.
// The model name lives on turn_context, not on token_count.
//
// Token semantics differ between the providers and must be reconciled here, or
// cross-provider comparison is nonsense. Codex reports input_tokens INCLUSIVE
// of the cached portion (total_tokens == input + output, cached ⊆ input),
// whereas Anthropic — the convention this schema already follows — keeps
// input_tokens and cache_read_tokens DISJOINT. So we subtract the cached part
// back out and store only the fresh input.
export function readTokenTotals(records: unknown[]): CodexTokenTotals | null {
  let model = "codex";
  let totals: Omit<CodexTokenTotals, "model" | "cache_write_tokens"> | null = null;

  for (const raw of records) {
    const r = asRec(raw);
    const p = r.payload ?? {};
    if (r.type === "turn_context" && typeof p.model === "string" && p.model) model = p.model;
    if (p.type === "token_count") {
      const info = (p.info as { total_token_usage?: Record<string, number> } | undefined)?.total_token_usage;
      if (info) {
        const cached = info.cached_input_tokens ?? 0;
        const inputInclCached = info.input_tokens ?? 0;
        totals = {
          input_tokens: Math.max(0, inputInclCached - cached), // fresh input only
          output_tokens: info.output_tokens ?? 0,
          cache_read_tokens: cached,
        };
      }
    }
  }

  if (!totals) return null;
  // Codex never reports cache writes, so that column stays 0 for OpenAI rows.
  return { model, ...totals, cache_write_tokens: 0 };
}

// Maps one rollout record to 0..2 monitor events. Self-contained per record —
// no cross-record pairing — so live tailing works even when a call and its
// result land in different read chunks.
export function mapEventRecord(record: unknown, threadId: string): CodexMappedEvent[] {
  const r = asRec(record);
  const p = r.payload ?? {};
  const t = String(p.type ?? "");
  const at = ms(r);

  const ev = (over: Partial<CodexMappedEvent>): CodexMappedEvent => ({
    event_type: "tool_call",
    tool_name: null,
    summary: null,
    content: null,
    files_affected: [],
    timestamp: at,
    source_id: "",
    ...over,
  });

  switch (t) {
    case "mcp_tool_call_end": {
      const callId = String(p.call_id ?? "");
      const inv = (p.invocation as { server?: string; tool?: string } | undefined) ?? {};
      const name = `mcp__${inv.server ?? "unknown"}__${inv.tool ?? "unknown"}`;
      const dur = (p.duration as { secs?: number; nanos?: number } | undefined) ?? {};
      const durMs = Math.round((dur.secs ?? 0) * 1000 + (dur.nanos ?? 0) / 1e6);
      const result = p.result as { Ok?: { isError?: boolean }; Err?: unknown } | undefined;
      const isError = result?.Err != null || result?.Ok?.isError === true;
      return [
        ev({ event_type: "tool_call", tool_name: name, summary: name, timestamp: at - durMs, source_id: `${callId}:call` }),
        ev({ event_type: "tool_result", tool_name: name, summary: isError ? "error" : "ok", source_id: `${callId}:result` }),
      ];
    }

    case "patch_apply_end": {
      const callId = String(p.call_id ?? "");
      const files = Object.keys((p.changes as Record<string, unknown> | undefined) ?? {});
      const ok = p.success === true;
      const label = `apply_patch (${files.length} file${files.length === 1 ? "" : "s"})`;
      return [
        ev({ event_type: "tool_call", tool_name: "apply_patch", summary: label, files_affected: files, source_id: `${callId}:call` }),
        ev({ event_type: "tool_result", tool_name: "apply_patch", summary: ok ? "ok" : "error", files_affected: files, source_id: `${callId}:result` }),
      ];
    }

    case "web_search_end":
      return [
        ev({
          event_type: "tool_call",
          tool_name: "web_search",
          summary: String(p.query ?? "").slice(0, 200),
          source_id: `${String(p.call_id ?? "")}:call`,
        }),
      ];

    case "context_compacted":
      return [ev({ event_type: "compaction", summary: "Context compaction", source_id: `${threadId}:compact:${at}` })];

    case "task_complete":
      return [ev({ event_type: "stop", summary: "Turn complete", source_id: String(p.turn_id ?? `${threadId}:stop:${at}`) })];

    // Codex runs shell commands through a custom tool named "exec".
    case "custom_tool_call": {
      if (p.name !== "exec") return [];
      const input = String(p.input ?? "");
      // Surface the actual shell command, the way Claude's Bash events carry
      // theirs — "exec" alone tells the activity feed nothing.
      const cmd = extractExecCommand(input);
      return [
        ev({
          event_type: "tool_call",
          tool_name: "exec",
          summary: (cmd || "exec").slice(0, 200),
          content: input.slice(0, 2000),
          source_id: `${String(p.call_id ?? "")}:call`,
        }),
      ];
    }

    case "custom_tool_call_output":
      return [
        ev({
          event_type: "tool_result",
          tool_name: "exec",
          summary: String(p.status ?? "") === "failed" ? "error" : "ok",
          content: String(p.output ?? "").slice(0, 2000),
          source_id: `${String(p.call_id ?? "")}:result`,
        }),
      ];

    default:
      // agent_reasoning / agent_message / user_message / sub_agent_activity and
      // friends are intentionally not recorded — the Claude hooks don't log
      // their equivalents either, and they'd bury the tool timeline.
      return [];
  }
}
