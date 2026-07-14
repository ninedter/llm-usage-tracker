import { describe, it, expect } from "vitest";
import {
  parseRolloutLines,
  readSessionInfo,
  readTokenTotals,
  mapEventRecord,
} from "@/lib/providers/codex-rollout";

const T = "2026-07-14T06:00:00.000Z";
const TMS = Date.parse(T);

// Shapes below mirror real records observed in ~/.codex/sessions/**/rollout-*.jsonl
const rec = (payload: object, type = "event_msg", timestamp = T) => ({ timestamp, type, payload });

describe("parseRolloutLines", () => {
  it("parses valid JSONL lines and skips blank/malformed ones", () => {
    const text = [
      JSON.stringify(rec({ type: "context_compacted" })),
      "not json",
      "",
      JSON.stringify(rec({ type: "task_complete", turn_id: "t1" })),
    ].join("\n");
    expect(parseRolloutLines(text)).toHaveLength(2);
  });
});

describe("readSessionInfo", () => {
  it("reads a root session from session_meta", () => {
    const info = readSessionInfo([
      rec({ session_id: "root-1", id: "root-1", cwd: "/Users/me/proj", originator: "codex_work_desktop" }, "session_meta"),
    ])!;
    expect(info.thread_id).toBe("root-1");
    expect(info.root_id).toBe("root-1");
    expect(info.is_subagent).toBe(false);
    expect(info.project).toBe("proj");
    expect(info.entrypoint).toBe("codex-work-desktop");
    expect(info.started_at).toBe(TMS);
  });

  it("detects a subagent thread and resolves its parent", () => {
    const info = readSessionInfo([
      rec({
        session_id: "sub-9", id: "sub-9", parent_thread_id: "root-1", cwd: "/Users/me/proj",
        thread_source: "subagent",
        source: { subagent: { thread_spawn: { parent_thread_id: "root-1", agent_nickname: "Hilbert" } } },
      }, "session_meta"),
    ])!;
    expect(info.is_subagent).toBe(true);
    expect(info.root_id).toBe("root-1");
    expect(info.description).toContain("Hilbert");
  });

  it("returns null when there is no session_meta", () => {
    expect(readSessionInfo([rec({ type: "task_complete" })])).toBeNull();
  });
});

describe("mapEventRecord", () => {
  it("maps mcp_tool_call_end to a tool_call + tool_result, backdating the call by its duration", () => {
    const evs = mapEventRecord(
      rec({
        type: "mcp_tool_call_end", call_id: "c1",
        invocation: { server: "node_repl", tool: "js", arguments: {} },
        duration: { secs: 0, nanos: 500_000_000 },
        result: { Ok: { isError: false } },
      }),
      "t1"
    );
    expect(evs.map((e) => e.event_type)).toEqual(["tool_call", "tool_result"]);
    expect(evs[0].tool_name).toBe("mcp__node_repl__js");
    expect(evs[0].timestamp).toBe(TMS - 500);
    expect(evs[1].timestamp).toBe(TMS);
    expect(evs[0].source_id).toBe("c1:call");
    expect(evs[1].source_id).toBe("c1:result");
    expect(evs[1].summary).toBe("ok");
  });

  it("flags an errored mcp call", () => {
    const evs = mapEventRecord(
      rec({
        type: "mcp_tool_call_end", call_id: "c2",
        invocation: { server: "s", tool: "t" }, duration: { secs: 0, nanos: 0 },
        result: { Ok: { isError: true } },
      }),
      "t1"
    );
    expect(evs[1].summary).toBe("error");
  });

  it("maps patch_apply_end to file events carrying the changed paths", () => {
    const evs = mapEventRecord(
      rec({
        type: "patch_apply_end", call_id: "p1", success: true,
        changes: { "/a/b.js": { type: "add" }, "/a/c.js": { type: "update" } },
      }),
      "t1"
    );
    expect(evs[0].tool_name).toBe("apply_patch");
    expect(evs[0].files_affected.sort()).toEqual(["/a/b.js", "/a/c.js"]);
    expect(evs[0].summary).toBe("apply_patch (2 files)");
    expect(evs[1].event_type).toBe("tool_result");
    expect(evs[1].summary).toBe("ok");
  });

  it("maps a custom_tool_call exec and its output to tool_call/tool_result", () => {
    const call = mapEventRecord(
      rec({ type: "custom_tool_call", call_id: "e1", name: "exec", input: "tools.exec_command({cmd:'ls'})" }, "response_item"),
      "t1"
    );
    expect(call).toHaveLength(1);
    expect(call[0].event_type).toBe("tool_call");
    expect(call[0].tool_name).toBe("exec");
    expect(call[0].source_id).toBe("e1:call");

    const out = mapEventRecord(
      rec({ type: "custom_tool_call_output", call_id: "e1", status: "completed", output: "ok" }, "response_item"),
      "t1"
    );
    expect(out[0].event_type).toBe("tool_result");
    expect(out[0].source_id).toBe("e1:result");
    expect(out[0].summary).toBe("ok");
  });

  it("ignores a non-exec custom tool call", () => {
    expect(mapEventRecord(rec({ type: "custom_tool_call", call_id: "x", name: "other" }, "response_item"), "t1")).toEqual([]);
  });

  it("maps web_search_end, context_compacted and task_complete", () => {
    expect(mapEventRecord(rec({ type: "web_search_end", call_id: "w1", query: "q" }), "t1")[0].tool_name).toBe("web_search");

    const compact = mapEventRecord(rec({ type: "context_compacted" }), "t1")[0];
    expect(compact.event_type).toBe("compaction");
    expect(compact.source_id).toBe(`t1:compact:${TMS}`);

    const stop = mapEventRecord(rec({ type: "task_complete", turn_id: "turn-9" }), "t1")[0];
    expect(stop.event_type).toBe("stop");
    expect(stop.source_id).toBe("turn-9");
  });

  it("skips the noisy record types we deliberately don't record", () => {
    for (const t of ["agent_reasoning", "agent_message", "user_message", "sub_agent_activity", "thread_settings_applied"]) {
      expect(mapEventRecord(rec({ type: t }), "t1"), t).toEqual([]);
    }
  });
});

describe("readTokenTotals", () => {
  it("takes the last cumulative total plus the model from turn_context", () => {
    const totals = readTokenTotals([
      rec({ model: "gpt-5.6-sol", cwd: "/p" }, "turn_context"),
      rec({ type: "token_count", info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } } }),
      rec({ type: "token_count", info: { total_token_usage: { input_tokens: 30, cached_input_tokens: 12, output_tokens: 7 } } }),
    ])!;
    expect(totals).toEqual({
      model: "gpt-5.6-sol",
      input_tokens: 18, // 30 total input − 12 cached
      output_tokens: 7,
      cache_read_tokens: 12,
      cache_write_tokens: 0,
    });
  });

  // Codex counts cached tokens INSIDE input_tokens; Anthropic keeps them apart.
  // Storing Codex's raw number would double-count the cache and wreck any
  // Claude-vs-OpenAI token comparison, so the cached part is subtracted out.
  it("stores input and cache_read as disjoint buckets, matching Anthropic's convention", () => {
    const totals = readTokenTotals([
      rec({ type: "token_count", info: { total_token_usage: { input_tokens: 1_000, cached_input_tokens: 950, output_tokens: 10 } } }),
    ])!;
    expect(totals.input_tokens).toBe(50);
    expect(totals.cache_read_tokens).toBe(950);
    expect(totals.input_tokens + totals.cache_read_tokens).toBe(1_000); // reconstructs Codex's total input
  });

  it("never goes negative if cached somehow exceeds input", () => {
    const totals = readTokenTotals([
      rec({ type: "token_count", info: { total_token_usage: { input_tokens: 5, cached_input_tokens: 9, output_tokens: 1 } } }),
    ])!;
    expect(totals.input_tokens).toBe(0);
  });

  it("returns null when the chunk has no token_count", () => {
    expect(readTokenTotals([rec({ model: "m" }, "turn_context")])).toBeNull();
  });
});
