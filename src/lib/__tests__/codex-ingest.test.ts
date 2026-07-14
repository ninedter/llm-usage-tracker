import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;
let logsDir: string;

beforeAll(() => {
  // getDb() resolves LLM_DATA_DIR lazily on its first call, so pointing it at a
  // temp dir here keeps this suite off the real .data/agent-monitor.db.
  tmpDir = mkdtempSync(join(tmpdir(), "llm-usage-tracker-codex-"));
  logsDir = mkdtempSync(join(tmpdir(), "llm-usage-tracker-rollouts-"));
  process.env.LLM_DATA_DIR = tmpDir;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(logsDir, { recursive: true, force: true });
});

import { getDb } from "@/lib/db";
import { ingestRolloutFile } from "@/lib/providers/codex-ingest";

const T = "2026-07-14T06:00:00.000Z";
const line = (payload: object, type = "event_msg", timestamp = T) =>
  JSON.stringify({ timestamp, type, payload });

function rootRollout(threadId: string): string {
  return (
    [
      line({ session_id: threadId, id: threadId, cwd: "/Users/me/proj", originator: "codex_work_desktop" }, "session_meta"),
      line({ model: "gpt-5.6-sol", cwd: "/Users/me/proj" }, "turn_context"),
      line({ type: "custom_tool_call", call_id: `${threadId}-e1`, name: "exec", input: "ls" }, "response_item"),
      line({ type: "custom_tool_call_output", call_id: `${threadId}-e1`, status: "completed", output: "ok" }, "response_item"),
      line({ type: "patch_apply_end", call_id: `${threadId}-p1`, success: true, changes: { "/Users/me/proj/a.js": { type: "add" } } }),
      line({ type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9 } } }),
    ].join("\n") + "\n"
  );
}

const write = (name: string, text: string) => {
  const fp = join(logsDir, name);
  writeFileSync(fp, text);
  return fp;
};

describe("ingestRolloutFile", () => {
  it("creates an openai session + agent, tool events, files and token usage", () => {
    const fp = write("rollout-a.jsonl", rootRollout("root-a"));
    const res = ingestRolloutFile(fp);

    expect(res.threadId).toBe("root-a");
    expect(res.inserted).toBe(4); // exec call + exec result + patch call + patch result

    const d = getDb();
    const session = d.prepare("SELECT provider, project, entrypoint FROM sessions WHERE id = 'codex:root-a'").get() as
      { provider: string; project: string; entrypoint: string };
    expect(session.provider).toBe("openai");
    expect(session.project).toBe("proj");
    expect(session.entrypoint).toBe("codex-work-desktop");

    const agent = d.prepare("SELECT session_id, type FROM agents WHERE id = 'codex:root-a'").get() as
      { session_id: string; type: string };
    expect(agent.session_id).toBe("codex:root-a");

    const events = d.prepare("SELECT provider, tool_name FROM agent_events WHERE session_id = 'codex:root-a'").all() as
      { provider: string; tool_name: string }[];
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.provider === "openai")).toBe(true);
    expect(events.map((e) => e.tool_name).sort()).toEqual(["apply_patch", "apply_patch", "exec", "exec"]);

    const patch = d.prepare(
      "SELECT files_affected FROM agent_events WHERE tool_name = 'apply_patch' AND event_type = 'tool_call' AND session_id = 'codex:root-a'"
    ).get() as { files_affected: string };
    expect(JSON.parse(patch.files_affected)).toEqual(["/Users/me/proj/a.js"]);

    const tokens = d.prepare("SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cost FROM token_usage WHERE session_id = 'codex:root-a'").get() as
      { provider: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost: number };
    expect(tokens).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      input_tokens: 60, // 100 total input − 40 cached, so it stays disjoint from cache_read
      output_tokens: 9,
      cache_read_tokens: 40,
      cost: 0, // flat subscription — never a fabricated dollar figure
    });
  });

  it("is idempotent — re-ingesting an unchanged file inserts nothing", () => {
    const fp = write("rollout-b.jsonl", rootRollout("root-b"));
    expect(ingestRolloutFile(fp).inserted).toBe(4);
    expect(ingestRolloutFile(fp).inserted).toBe(0);

    const n = getDb().prepare("SELECT COUNT(*) AS n FROM agent_events WHERE session_id = 'codex:root-b'").get() as { n: number };
    expect(n.n).toBe(4);
  });

  it("tails appended lines from the cursor and reports only the new events", () => {
    const fp = write("rollout-c.jsonl", rootRollout("root-c"));
    ingestRolloutFile(fp);

    appendFileSync(fp, line({ type: "web_search_end", call_id: "root-c-w", query: "hello" }) + "\n");

    const seen: string[] = [];
    const res = ingestRolloutFile(fp, (e) => seen.push(e.tool_name ?? ""));
    expect(res.inserted).toBe(1);
    expect(seen).toEqual(["web_search"]); // fires only for genuinely new rows
  });

  it("leaves a half-written trailing line alone until its newline arrives", () => {
    const fp = write("rollout-d.jsonl", rootRollout("root-d"));
    ingestRolloutFile(fp);

    appendFileSync(fp, line({ type: "web_search_end", call_id: "root-d-w", query: "partial" })); // no "\n" yet
    expect(ingestRolloutFile(fp).inserted).toBe(0);

    appendFileSync(fp, "\n");
    expect(ingestRolloutFile(fp).inserted).toBe(1);
  });

  it("records a subagent thread as its own openai session, tagged with its parent", () => {
    const fp = write(
      "rollout-sub.jsonl",
      [
        line({
          session_id: "sub-9", id: "sub-9", parent_thread_id: "root-1", cwd: "/Users/me/proj",
          originator: "codex_work_desktop", thread_source: "subagent",
          source: { subagent: { thread_spawn: { parent_thread_id: "root-1", agent_nickname: "Hilbert" } } },
        }, "session_meta"),
        line({ type: "web_search_end", call_id: "sub-9-w", query: "x" }),
      ].join("\n") + "\n"
    );

    ingestRolloutFile(fp);

    const agent = getDb().prepare(
      "SELECT session_id, subagent_type, parent_agent_id, metadata FROM agents WHERE id = 'codex:sub-9'"
    ).get() as { session_id: string; subagent_type: string; parent_agent_id: string | null; metadata: string };

    expect(agent.session_id).toBe("codex:sub-9");
    expect(agent.subagent_type).toBe("codex");
    expect(agent.parent_agent_id).toBeNull(); // parent link lives in metadata — no cross-file FK
    expect(JSON.parse(agent.metadata).parent_thread_id).toBe("root-1");
  });
});
