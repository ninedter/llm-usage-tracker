import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";

// getDb() reads LLM_DATA_DIR lazily on its first call, so pointing it at an
// isolated temp dir before importing the routes keeps this suite off the real
// .data/agent-monitor.db.
let tmpDir: string;
let db: typeof import("@/lib/db");
let machines: typeof import("@/app/api/machines/route");
let hubInfo: typeof import("@/app/api/hub-info/route");
let monitorSessions: typeof import("@/app/api/monitor/sessions/route");
let monitorAgents: typeof import("@/app/api/monitor/agents/route");
let monitorStats: typeof import("@/app/api/monitor/stats/route");
let monitorEvents: typeof import("@/app/api/monitor/events/route");
let analyticsOverview: typeof import("@/app/api/analytics/overview/route");
let analyticsSessions: typeof import("@/app/api/analytics/sessions/route");
let analyticsTools: typeof import("@/app/api/analytics/tools/route");

const MINI = "henrys-mac-mini";
const LAPTOP = "laptop-01";
const NOW = Date.now();

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "machine-routes-test-"));
  process.env.LLM_DATA_DIR = tmpDir;
  db = await import("@/lib/db");
  machines = await import("@/app/api/machines/route");
  hubInfo = await import("@/app/api/hub-info/route");
  monitorSessions = await import("@/app/api/monitor/sessions/route");
  monitorAgents = await import("@/app/api/monitor/agents/route");
  monitorStats = await import("@/app/api/monitor/stats/route");
  monitorEvents = await import("@/app/api/monitor/events/route");
  analyticsOverview = await import("@/app/api/analytics/overview/route");
  analyticsSessions = await import("@/app/api/analytics/sessions/route");
  analyticsTools = await import("@/app/api/analytics/tools/route");

  for (const [machineId, label, project, tool] of [
    [MINI, "Mac mini", "hub-proj", "Read"],
    [LAPTOP, "MacBook Pro", "laptop-proj", "Write"],
  ] as const) {
    db.createSession(
      { id: "sess-1", status: "active", project, cwd: "/w", entrypoint: "cli", started_at: NOW, ended_at: null, metadata: null },
      "anthropic",
      { id: machineId, label }
    );
    db.createAgent(
      {
        id: "agent-1", session_id: "sess-1", parent_agent_id: null, type: "main", subagent_type: null,
        description: `${label} agent`, status: "working", current_tool: null, started_at: NOW, ended_at: null, metadata: null,
      },
      machineId
    );
    db.createEvent(
      {
        agent_id: "agent-1", session_id: "sess-1", event_type: "tool_call", tool_name: tool,
        summary: label, content: null, files_affected: null, timestamp: NOW,
      },
      "anthropic",
      `src-${machineId}`,
      machineId
    );
  }
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const req = (path: string) => new NextRequest(`http://hub.local${path}`);

async function ok<T>(res: Response): Promise<T> {
  const json = await res.json();
  expect(res.status).toBe(200);
  expect(json.success).toBe(true);
  return json.data as T;
}

const RANGE = `from=${NOW - 86400000}&to=${NOW + 86400000}`;

describe("GET /api/machines (filter options)", () => {
  it("lists every machine the hub has heard from, with labels", async () => {
    const data = await ok<{ id: string; label: string | null; last_seen_at: number }[]>(await machines.GET());
    expect(data.map((m) => m.id).sort()).toEqual([LAPTOP, MINI].sort());
    expect(new Map(data.map((m) => [m.id, m.label])).get(LAPTOP)).toBe("MacBook Pro");
  });
});

describe("GET /api/hub-info", () => {
  it("falls back to the locked default hub URL when the env var is unset", async () => {
    const previous = process.env.NEXT_PUBLIC_HUB_URL;
    delete process.env.NEXT_PUBLIC_HUB_URL;
    const data = await ok<{ hub_url: string }>(await hubInfo.GET());
    expect(data.hub_url).toBe("http://henrys-mac-mini:3789");
    if (previous !== undefined) process.env.NEXT_PUBLIC_HUB_URL = previous;
  });

  it("reads the configured URL at request time, not build time", async () => {
    const previous = process.env.NEXT_PUBLIC_HUB_URL;
    process.env.NEXT_PUBLIC_HUB_URL = "http://other-hub:3789";
    const data = await ok<{ hub_url: string }>(await hubInfo.GET());
    expect(data.hub_url).toBe("http://other-hub:3789");
    if (previous === undefined) delete process.env.NEXT_PUBLIC_HUB_URL;
    else process.env.NEXT_PUBLIC_HUB_URL = previous;
  });
});

describe("?machine= on monitor routes", () => {
  it("omitting the param (the All option) returns every machine", async () => {
    const sessions = await ok<{ project: string }[]>(await monitorSessions.GET(req("/api/monitor/sessions")));
    expect(sessions.length).toBe(2);

    const stats = await ok<{ total_sessions: number }>(await monitorStats.GET(req("/api/monitor/stats")));
    expect(stats.total_sessions).toBe(2);
  });

  it("machine=all is treated the same as omitting it", async () => {
    const stats = await ok<{ total_sessions: number }>(await monitorStats.GET(req("/api/monitor/stats?machine=all")));
    expect(stats.total_sessions).toBe(2);
  });

  it("scopes sessions, agents, stats and the activity feed to one machine", async () => {
    const sessions = await ok<{ project: string; machine_id: string }[]>(
      await monitorSessions.GET(req(`/api/monitor/sessions?machine=${MINI}`))
    );
    expect(sessions.map((s) => s.project)).toEqual(["hub-proj"]);
    expect(sessions[0].machine_id).toBe(MINI);

    const agents = await ok<{ description: string }[]>(
      await monitorAgents.GET(req(`/api/monitor/agents?limit=200&machine=${LAPTOP}`))
    );
    expect(agents.map((a) => a.description)).toEqual(["MacBook Pro agent"]);

    const stats = await ok<{ total_sessions: number; total_events: number }>(
      await monitorStats.GET(req(`/api/monitor/stats?machine=${LAPTOP}`))
    );
    expect(stats.total_sessions).toBe(1);
    expect(stats.total_events).toBe(1);

    const events = await ok<{ summary: string; machine_id: string }[]>(
      await monitorEvents.GET(req(`/api/monitor/events?limit=100&machine=${MINI}`))
    );
    expect(events.map((e) => e.summary)).toEqual(["Mac mini"]);
  });

  it("combines with ?provider=", async () => {
    const scoped = await ok<{ total_sessions: number }>(
      await monitorStats.GET(req(`/api/monitor/stats?provider=anthropic&machine=${MINI}`))
    );
    expect(scoped.total_sessions).toBe(1);

    const other = await ok<{ total_sessions: number }>(
      await monitorStats.GET(req(`/api/monitor/stats?provider=openai&machine=${MINI}`))
    );
    expect(other.total_sessions).toBe(0);
  });
});

describe("?machine= on analytics routes", () => {
  it("scopes the overview, session table and tool panel", async () => {
    const all = await ok<{ session_count: number }>(
      await analyticsOverview.GET(req(`/api/analytics/overview?${RANGE}`))
    );
    expect(all.session_count).toBe(2);

    const mini = await ok<{ session_count: number; tool_call_count: number }>(
      await analyticsOverview.GET(req(`/api/analytics/overview?${RANGE}&machine=${MINI}`))
    );
    expect(mini.session_count).toBe(1);
    expect(mini.tool_call_count).toBe(1);

    const rows = await ok<{ project: string }[]>(
      await analyticsSessions.GET(req(`/api/analytics/sessions?${RANGE}&machine=${LAPTOP}`))
    );
    expect(rows.map((r) => r.project)).toEqual(["laptop-proj"]);

    const tools = await ok<{ tools: { tool_name: string }[] }>(
      await analyticsTools.GET(req(`/api/analytics/tools?${RANGE}&machine=${LAPTOP}`))
    );
    expect(tools.tools.map((t) => t.tool_name)).toEqual(["Write"]);
  });
});

describe("invalid ?machine= is rejected, never silently unscoped", () => {
  const cases: [string, () => Promise<Response>][] = [
    ["monitor/sessions", () => monitorSessions.GET(req("/api/monitor/sessions?machine=bad%20id"))],
    ["monitor/agents", () => monitorAgents.GET(req("/api/monitor/agents?machine=bad%20id"))],
    ["monitor/stats", () => monitorStats.GET(req("/api/monitor/stats?machine=bad%20id"))],
    ["monitor/events", () => monitorEvents.GET(req("/api/monitor/events?machine=bad%20id"))],
    ["analytics/overview", () => analyticsOverview.GET(req(`/api/analytics/overview?${RANGE}&machine=bad%20id`))],
    ["analytics/sessions", () => analyticsSessions.GET(req(`/api/analytics/sessions?${RANGE}&machine=bad%20id`))],
    ["analytics/tools", () => analyticsTools.GET(req(`/api/analytics/tools?${RANGE}&machine=bad%20id`))],
  ];

  for (const [name, call] of cases) {
    it(`${name} answers 400`, async () => {
      const res = await call();
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe("INVALID_MACHINE");
    });
  }
});
