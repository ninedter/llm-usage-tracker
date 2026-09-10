import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "llm-usage-tracker-mfilter-"));
  process.env.LLM_DATA_DIR = tmpDir;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

import { readMachine } from "@/lib/machine-param";
import { machineParam, machineDisplayName, ALL_MACHINES } from "@/components/ui/MachineFilter";
import {
  createSession,
  createAgent,
  createEvent,
  upsertTokenUsage,
  listAgents,
  listSessions,
  listMachines,
  listRecentEvents,
  getMonitorStats,
  getAnalyticsOverview,
  getAnalyticsTrends,
  getSessionAnalytics,
  getToolAnalytics,
  getFileAnalytics,
  getModelAnalytics,
  getUsageInsights,
  rollupDailyUsageRange,
} from "@/lib/db";

const NOW = Date.now();
const FROM = NOW - 86400000;
const TO = NOW + 86400000;

const MINI = "henrys-mac-mini";
const LAPTOP = "b6b3f0f4-6f1a-4a1e-9a9f-2f2a6e0f1c34";

// Two machines reporting the *same* session and agent ids — the case machine
// scoping exists for. The hub keys those rows by (machine_id, id), so an
// unscoped read sees both and a scoped read sees exactly one.
beforeAll(() => {
  const seed = (machineId: string, label: string, project: string, file: string, cost: number) => {
    createSession(
      { id: "sess-1", status: "active", project, cwd: "/w", entrypoint: "cli", started_at: NOW, ended_at: null, metadata: null },
      "anthropic",
      { id: machineId, label }
    );
    createAgent(
      {
        id: "agent-1", session_id: "sess-1", parent_agent_id: null, type: "main", subagent_type: null,
        description: `${label} agent`, status: "working", current_tool: null, started_at: NOW, ended_at: null, metadata: null,
      },
      machineId
    );
    createEvent(
      {
        agent_id: "agent-1", session_id: "sess-1", event_type: "tool_call",
        tool_name: machineId === MINI ? "Read" : "Write", summary: label, content: null,
        files_affected: JSON.stringify([file]), timestamp: NOW,
      },
      "anthropic",
      `src-${machineId}`,
      machineId
    );
    upsertTokenUsage(
      {
        session_id: "sess-1", model: machineId === MINI ? "claude-opus" : "claude-sonnet",
        input_tokens: 10, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost, updated_at: NOW,
      },
      "anthropic",
      machineId
    );
  };

  seed(MINI, "Mac mini", "hub-proj", "/w/hub.ts", 5);
  seed(LAPTOP, "MacBook Pro", "laptop-proj", "/w/laptop.ts", 3);
  rollupDailyUsageRange(FROM, TO);
});

describe("readMachine (?machine= on API routes)", () => {
  const read = (qs: string) => readMachine(new URL(`http://hub.local/api/x${qs}`));

  it("treats absent, empty and 'all' as unscoped", () => {
    expect(read("")).toBeUndefined();
    expect(read("?machine=")).toBeUndefined();
    expect(read("?machine=all")).toBeUndefined();
    expect(read("?provider=openai")).toBeUndefined();
  });

  it("returns a valid machine id", () => {
    expect(read(`?machine=${MINI}`)).toBe(MINI);
    expect(read(`?machine=${LAPTOP}`)).toBe(LAPTOP);
    expect(read("?machine=host.local:3789")).toBe("host.local:3789");
  });

  it("rejects ids outside the ingest charset, so a typo can't read as unscoped", () => {
    expect(read("?machine=has%20space")).toBeNull();
    expect(read("?machine=drop%3Btable")).toBeNull();
    expect(read("?machine=%27%20OR%201%3D1")).toBeNull();
    expect(read(`?machine=${"x".repeat(129)}`)).toBeNull();
  });
});

describe("machineParam (query-string serialisation)", () => {
  it("sends nothing for All so the server stays unscoped", () => {
    expect(machineParam(ALL_MACHINES)).toBe("");
  });

  it("appends a specific machine, url-encoded", () => {
    expect(machineParam(MINI)).toBe(`&machine=${MINI}`);
    expect(machineParam("host.local:3789")).toBe("&machine=host.local%3A3789");
  });

  it("round-trips through readMachine", () => {
    const url = new URL(`http://hub.local/api/x?from=1&to=2${machineParam(MINI)}`);
    expect(readMachine(url)).toBe(MINI);
  });

  it("falls back to the id when a machine reported no label", () => {
    expect(machineDisplayName({ id: MINI, label: "Mac mini", last_seen_at: NOW })).toBe("Mac mini");
    expect(machineDisplayName({ id: MINI, label: null, last_seen_at: NOW })).toBe(MINI);
    expect(machineDisplayName({ id: MINI, label: "  ", last_seen_at: NOW })).toBe(MINI);
  });
});

describe("machine scoping in db queries", () => {
  it("listMachines reports both machines, newest first, with labels", () => {
    const machines = listMachines();
    expect(machines.map((m) => m.id).sort()).toEqual([LAPTOP, MINI].sort());
    expect(machines.map((m) => m.last_seen_at)).toEqual([...machines.map((m) => m.last_seen_at)].sort((a, b) => b - a));
    expect(new Map(machines.map((m) => [m.id, m.label])).get(MINI)).toBe("Mac mini");
  });

  it("listSessions: unscoped keeps both machines' same-id sessions apart", () => {
    expect(listSessions().length).toBe(2);
    expect(listSessions(50, undefined, MINI).map((s) => s.project)).toEqual(["hub-proj"]);
    expect(listSessions(50, undefined, LAPTOP).map((s) => s.project)).toEqual(["laptop-proj"]);
  });

  it("listAgents scopes by machine and still scopes by provider", () => {
    expect(listAgents().length).toBe(2);
    expect(listAgents({ machine_id: MINI }).map((a) => a.description)).toEqual(["Mac mini agent"]);
    expect(listAgents({ machine_id: LAPTOP, provider: "anthropic" }).map((a) => a.description)).toEqual(["MacBook Pro agent"]);
    expect(listAgents({ machine_id: LAPTOP, provider: "openai" })).toEqual([]);
  });

  it("listRecentEvents scopes the activity feed", () => {
    expect(listRecentEvents(100).length).toBe(2);
    expect(listRecentEvents(100, undefined, MINI).map((e) => e.summary)).toEqual(["Mac mini"]);
    expect(listRecentEvents(100, undefined, LAPTOP).every((e) => e.machine_id === LAPTOP)).toBe(true);
  });

  it("getMonitorStats scopes counts and cost", () => {
    expect(getMonitorStats().total_sessions).toBe(2);

    const mini = getMonitorStats(undefined, MINI);
    expect(mini.total_sessions).toBe(1);
    expect(mini.total_agents).toBe(1);
    expect(mini.total_events).toBe(1);
    expect(mini.total_cost).toBe(5);

    expect(getMonitorStats(undefined, LAPTOP).total_cost).toBe(3);
  });

  it("getAnalyticsOverview scopes cost, sessions and top model", () => {
    expect(getAnalyticsOverview(FROM, TO).total_cost).toBe(8);

    const mini = getAnalyticsOverview(FROM, TO, undefined, MINI);
    expect(mini.session_count).toBe(1);
    expect(mini.total_cost).toBe(5);
    expect(mini.top_model).toBe("claude-opus");
    expect(mini.tool_call_count).toBe(1);

    expect(getAnalyticsOverview(FROM, TO, undefined, LAPTOP).top_model).toBe("claude-sonnet");
  });

  it("combines the machine and provider filters", () => {
    expect(getAnalyticsOverview(FROM, TO, "anthropic", MINI).total_cost).toBe(5);
    expect(getAnalyticsOverview(FROM, TO, "openai", MINI).total_cost).toBe(0);
  });

  it("getSessionAnalytics scopes rows and tags them with their machine", () => {
    expect(getSessionAnalytics(FROM, TO).length).toBe(2);
    const rows = getSessionAnalytics(FROM, TO, "started_at", "desc", 20, 0, undefined, LAPTOP);
    expect(rows.map((r) => r.project)).toEqual(["laptop-proj"]);
    expect(rows[0].machine_id).toBe(LAPTOP);
  });

  it("getToolAnalytics / getFileAnalytics / getUsageInsights scope per machine", () => {
    expect(getToolAnalytics(FROM, TO, undefined, MINI).tools.map((t) => t.tool_name)).toEqual(["Read"]);
    expect(getToolAnalytics(FROM, TO, undefined, LAPTOP).tools.map((t) => t.tool_name)).toEqual(["Write"]);
    expect(getFileAnalytics(FROM, TO, undefined, MINI).files.map((f) => f.file_path)).toEqual(["/w/hub.ts"]);
    expect(getUsageInsights(FROM, TO, undefined, LAPTOP).projects.map((p) => p.project)).toEqual(["laptop-proj"]);
    expect(getUsageInsights(FROM, TO, undefined, MINI).stats.top_tool).toBe("Read");
  });

  it("getModelAnalytics scopes both the model list and the daily rollup trend", () => {
    expect(getModelAnalytics(FROM, TO).models.map((m) => m.model).sort()).toEqual(["claude-opus", "claude-sonnet"]);

    const mini = getModelAnalytics(FROM, TO, undefined, MINI);
    expect(mini.models.map((m) => m.model)).toEqual(["claude-opus"]);
    // daily_usage carries machine_id, so a machine-only scope keeps the rollup
    // path instead of falling back to a live token_usage join.
    expect(mini.trend.every((t) => t.model === "claude-opus")).toBe(true);
    expect(mini.trend.reduce((n, t) => n + t.cost, 0)).toBe(5);
  });

  it("getAnalyticsTrends scopes the daily cost series", () => {
    const sum = (points: { cost: number; events: number; sessions: number }[]) =>
      points.reduce((acc, p) => ({
        cost: acc.cost + p.cost,
        events: acc.events + p.events,
        sessions: acc.sessions + p.sessions,
      }), { cost: 0, events: 0, sessions: 0 });

    expect(sum(getAnalyticsTrends(FROM, TO, "daily")).cost).toBe(8);

    const mini = sum(getAnalyticsTrends(FROM, TO, "daily", undefined, MINI));
    expect(mini.cost).toBe(5);
    expect(mini.events).toBe(1);
    expect(mini.sessions).toBe(1);
  });

  it("an unscoped call still sees every machine (All is not a filter)", () => {
    expect(getUsageInsights(FROM, TO).projects.map((p) => p.project).sort()).toEqual(["hub-proj", "laptop-proj"]);
    expect(getFileAnalytics(FROM, TO).files.length).toBe(2);
  });
});
