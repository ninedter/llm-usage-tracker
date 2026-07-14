import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

beforeAll(() => {
  process.env.LLM_DATA_DIR = mkdtempSync(join(tmpdir(), "analytics-test-"));
});

import {
  getDb, createSession, createAgent, createEvent, upsertTokenUsage,
  getToolAnalytics, getSessionAnalytics,
} from "@/lib/db";

const T0 = Date.parse("2026-07-01T10:00:00Z");

function seed() {
  getDb();
  createSession({ id: "s1", status: "active", project: "proj", cwd: "/p", entrypoint: "cli", started_at: T0, ended_at: null, metadata: null });
  createAgent({ id: "a1", session_id: "s1", parent_agent_id: null, type: "main", subagent_type: null, description: "", status: "working", current_tool: null, started_at: T0, ended_at: null, metadata: null });
  // Read called twice: 1000ms and 3000ms call→result gaps → avg 2000
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_call", tool_name: "Read", summary: "r1", content: null, files_affected: null, timestamp: T0 });
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_result", tool_name: "Read", summary: "ok", content: null, files_affected: null, timestamp: T0 + 1000 });
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_call", tool_name: "Read", summary: "r2", content: null, files_affected: null, timestamp: T0 + 10_000 });
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_result", tool_name: "Read", summary: "ok", content: null, files_affected: null, timestamp: T0 + 13_000 });
  // Bash: one call, one FAILING result
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_call", tool_name: "Bash", summary: "b1", content: null, files_affected: null, timestamp: T0 + 20_000 });
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_result", tool_name: "Bash", summary: "command failed with error", content: null, files_affected: null, timestamp: T0 + 21_000 });
  // Orphan result >300s after its call must NOT pair
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_call", tool_name: "Glob", summary: "g1", content: null, files_affected: null, timestamp: T0 + 30_000 });
  createEvent({ agent_id: "a1", session_id: "s1", event_type: "tool_result", tool_name: "Glob", summary: "ok", content: null, files_affected: null, timestamp: T0 + 30_000 + 301_000 });
  upsertTokenUsage({ session_id: "s1", model: "claude-opus", input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0, cost: 1.25, updated_at: T0 });
}

// Seed data once before all tests
beforeAll(seed);

describe("getToolAnalytics (single-pass rewrite)", () => {
  it("counts calls per tool, ordered by count", () => {
    const { tools } = getToolAnalytics(T0 - 1000, T0 + 10 * 86400000);
    const read = tools.find(t => t.tool_name === "Read")!;
    expect(read.call_count).toBe(2);
    expect(tools[0].tool_name).toBe("Read");
  });

  it("pairs each result with nearest preceding call within 300s", () => {
    const { tools } = getToolAnalytics(T0 - 1000, T0 + 10 * 86400000);
    expect(tools.find(t => t.tool_name === "Read")!.avg_duration_ms).toBe(2000);
    expect(tools.find(t => t.tool_name === "Glob")!.avg_duration_ms).toBe(0); // orphan not paired
  });

  it("counts failures from result summaries and derives success rate", () => {
    const { tools } = getToolAnalytics(T0 - 1000, T0 + 10 * 86400000);
    const bash = tools.find(t => t.tool_name === "Bash")!;
    expect(bash.failure_count).toBe(1);
    expect(bash.success_count).toBe(0);
    expect(bash.success_rate).toBe(0);
    const read = tools.find(t => t.tool_name === "Read")!;
    expect(read.failure_count).toBe(0);
    expect(read.success_rate).toBe(100);
  });

  it("returns a timeline capped at 500, oldest-first", () => {
    const { timeline } = getToolAnalytics(T0 - 1000, T0 + 10 * 86400000);
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline.length).toBeLessThanOrEqual(500);
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i].timestamp).toBeGreaterThanOrEqual(timeline[i - 1].timestamp);
    }
  });
});

describe("getSessionAnalytics (JOIN rewrite)", () => {
  it("aggregates tokens, cost and tool_count per session", () => {
    const rows = getSessionAnalytics(T0 - 1000, T0 + 10 * 86400000, "started_at", "desc", 20, 0);
    const s1 = rows.find(r => r.session_id === "s1")!;
    expect(s1.total_tokens).toBe(150);
    expect(s1.cost).toBeCloseTo(1.25);
    expect(s1.tool_count).toBe(4); // tool_call events: Read×2 + Bash×1 + Glob×1
  });

  it("sorts by computed columns", () => {
    const rows = getSessionAnalytics(T0 - 1000, T0 + 10 * 86400000, "cost", "desc", 20, 0);
    expect(rows[0].session_id).toBe("s1");
  });
});
