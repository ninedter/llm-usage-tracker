import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "llm-usage-tracker-pfilter-"));
  process.env.LLM_DATA_DIR = tmpDir;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

import {
  getDb,
  createSession,
  createAgent,
  createEvent,
  upsertTokenUsage,
  listAgents,
  listSessions,
  getMonitorStats,
  getAnalyticsOverview,
  getToolAnalytics,
  getFileAnalytics,
  getModelAnalytics,
  getUsageInsights,
} from "@/lib/db";

const NOW = Date.now();
const FROM = NOW - 86400000;
const TO = NOW + 86400000;

// One Claude session and one Codex session, each with a tool_call that touches a
// file, so every panel has something to filter.
beforeAll(() => {
  createSession(
    { id: "s-claude", status: "active", project: "claude-proj", cwd: "/c", entrypoint: "cli", started_at: NOW, ended_at: null, metadata: null },
    "anthropic"
  );
  createAgent({
    id: "a-claude", session_id: "s-claude", parent_agent_id: null, type: "main", subagent_type: null,
    description: "claude agent", status: "working", current_tool: null, started_at: NOW, ended_at: null, metadata: null,
  });
  createEvent(
    { agent_id: "a-claude", session_id: "s-claude", event_type: "tool_call", tool_name: "Bash", summary: null, content: null, files_affected: JSON.stringify(["/c/one.ts"]), timestamp: NOW },
    "anthropic"
  );
  upsertTokenUsage(
    { session_id: "s-claude", model: "claude-opus", input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost: 5, updated_at: NOW },
    "anthropic"
  );

  createSession(
    { id: "codex:s-openai", status: "active", project: "codex-proj", cwd: "/o", entrypoint: "codex-cli", started_at: NOW, ended_at: null, metadata: null },
    "openai"
  );
  createAgent({
    id: "codex:a-openai", session_id: "codex:s-openai", parent_agent_id: null, type: "main", subagent_type: null,
    description: "codex agent", status: "working", current_tool: null, started_at: NOW, ended_at: null, metadata: null,
  });
  createEvent(
    { agent_id: "codex:a-openai", session_id: "codex:s-openai", event_type: "tool_call", tool_name: "exec", summary: null, content: null, files_affected: JSON.stringify(["/o/two.py"]), timestamp: NOW },
    "openai",
    "codex-src-1"
  );
  upsertTokenUsage(
    { session_id: "codex:s-openai", model: "gpt-5.6-sol", input_tokens: 100, output_tokens: 9, cache_read_tokens: 40, cache_write_tokens: 0, cost: 0, updated_at: NOW },
    "openai"
  );
});

describe("provider scoping", () => {
  it("listAgents: unscoped returns both, scoped returns only that provider", () => {
    expect(listAgents().map((a) => a.id).sort()).toEqual(["a-claude", "codex:a-openai"]);
    expect(listAgents({ provider: "openai" }).map((a) => a.id)).toEqual(["codex:a-openai"]);
    expect(listAgents({ provider: "anthropic" }).map((a) => a.id)).toEqual(["a-claude"]);
  });

  it("listAgents: agents inherit provider from their session (no provider column on agents)", () => {
    const byId = new Map(listAgents().map((a) => [a.id, a.provider]));
    expect(byId.get("a-claude")).toBe("anthropic");
    expect(byId.get("codex:a-openai")).toBe("openai");
  });

  it("listSessions scopes by provider", () => {
    expect(listSessions().length).toBe(2);
    expect(listSessions(50, "openai").map((s) => s.session_id)).toEqual(["codex:s-openai"]);
    expect(listSessions(50, "anthropic").map((s) => s.session_id)).toEqual(["s-claude"]);
  });

  it("getMonitorStats scopes counts and cost", () => {
    expect(getMonitorStats().total_sessions).toBe(2);

    const openai = getMonitorStats("openai");
    expect(openai.total_sessions).toBe(1);
    expect(openai.total_agents).toBe(1);
    expect(openai.total_cost).toBe(0); // Codex is a flat subscription

    const claude = getMonitorStats("anthropic");
    expect(claude.total_sessions).toBe(1);
    expect(claude.total_cost).toBe(5);
  });

  it("getAnalyticsOverview scopes cost, sessions and tool calls", () => {
    expect(getAnalyticsOverview(FROM, TO).session_count).toBe(2);

    const openai = getAnalyticsOverview(FROM, TO, "openai");
    expect(openai.session_count).toBe(1);
    expect(openai.total_cost).toBe(0);
    expect(openai.tool_call_count).toBe(1);
    expect(openai.top_model).toBe("gpt-5.6-sol");

    const claude = getAnalyticsOverview(FROM, TO, "anthropic");
    expect(claude.total_cost).toBe(5);
    expect(claude.top_model).toBe("claude-opus");
  });

  it("getToolAnalytics keeps each provider's native tool names apart", () => {
    expect(getToolAnalytics(FROM, TO).tools.map((t) => t.tool_name).sort()).toEqual(["Bash", "exec"]);
    expect(getToolAnalytics(FROM, TO, "openai").tools.map((t) => t.tool_name)).toEqual(["exec"]);
    expect(getToolAnalytics(FROM, TO, "anthropic").tools.map((t) => t.tool_name)).toEqual(["Bash"]);
  });

  it("getFileAnalytics scopes touched files", () => {
    expect(getFileAnalytics(FROM, TO, "openai").files.map((f) => f.file_path)).toEqual(["/o/two.py"]);
    expect(getFileAnalytics(FROM, TO, "anthropic").files.map((f) => f.file_path)).toEqual(["/c/one.ts"]);
  });

  it("getModelAnalytics scopes models (daily_usage has no provider, so it reads token_usage live)", () => {
    expect(getModelAnalytics(FROM, TO, "openai").models.map((m) => m.model)).toEqual(["gpt-5.6-sol"]);
    expect(getModelAnalytics(FROM, TO, "anthropic").models.map((m) => m.model)).toEqual(["claude-opus"]);
    expect(getModelAnalytics(FROM, TO).models.length).toBe(2);
  });

  it("getUsageInsights scopes projects and tool mix", () => {
    expect(getUsageInsights(FROM, TO, "openai").projects.map((p) => p.project)).toEqual(["codex-proj"]);
    expect(getUsageInsights(FROM, TO, "anthropic").projects.map((p) => p.project)).toEqual(["claude-proj"]);
    expect(getUsageInsights(FROM, TO, "openai").stats.top_tool).toBe("exec");
    expect(getUsageInsights(FROM, TO, "anthropic").stats.top_tool).toBe("Bash");
  });

  it("classifies Codex exec calls into the explore/modify mix by command verb", () => {
    const execEvent = (id: string, cmd: string) =>
      createEvent(
        {
          agent_id: "codex:a-openai", session_id: "codex:s-openai", event_type: "tool_call",
          tool_name: "exec", summary: cmd,
          content: `const r = await tools.exec_command({"cmd":${JSON.stringify(cmd)}})`,
          files_affected: null, timestamp: NOW,
        },
        "openai",
        id
      );

    execEvent("exec-explore-1", 'rg -n "pattern" src');
    execEvent("exec-explore-2", "cat package.json");
    execEvent("exec-modify-1", "rm -rf .next/cache");
    execEvent("exec-neither-1", "npm test"); // ambiguous runner — counted as neither

    const stats = getUsageInsights(FROM, TO, "openai").stats;
    expect(stats.explore_calls).toBe(2);
    expect(stats.modify_calls).toBe(1);

    // The Claude scope is untouched by exec classification
    const claude = getUsageInsights(FROM, TO, "anthropic").stats;
    expect(claude.explore_calls).toBe(0); // Bash is deliberately unclassified there
  });

  it("an unscoped call still sees everything (the All tab is not a filter)", () => {
    const count = (p?: "anthropic" | "openai") =>
      (getDb().prepare(`SELECT COUNT(*) AS n FROM agent_events${p ? " WHERE provider = ?" : ""}`)
        .get(...(p ? [p] : [])) as { n: number }).n;
    expect(count("anthropic") + count("openai")).toBe(count());
    expect(count()).toBeGreaterThan(0);
    expect(getUsageInsights(FROM, TO).projects.length).toBe(2);
  });
});
