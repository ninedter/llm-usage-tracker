import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";

// getDb() reads LLM_DATA_DIR lazily on its first call, so pointing it at an
// isolated temp dir before importing the routes keeps this suite off the real
// .data/agent-monitor.db.
let tmpDir: string;
let db: typeof import("@/lib/db");
let ingest: typeof import("@/app/api/ingest/v1/route");
let machines: typeof import("@/app/api/machines/route");
let monitorEvents: typeof import("@/app/api/monitor/events/route");

const TOKEN = "test-ingest-token";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ingest-route-test-"));
  process.env.LLM_DATA_DIR = tmpDir;
  process.env.INGEST_TOKEN = TOKEN;
  db = await import("@/lib/db");
  ingest = await import("@/app/api/ingest/v1/route");
  machines = await import("@/app/api/machines/route");
  monitorEvents = await import("@/app/api/monitor/events/route");
});

afterAll(() => {
  delete process.env.INGEST_TOKEN;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.INGEST_TOKEN = TOKEN;
  const d = db.getDb();
  for (const t of ["agent_events", "agents", "token_usage", "sessions", "daily_usage"]) {
    d.prepare(`DELETE FROM ${t}`).run();
  }
});

function post(body: unknown, token: string | null): NextRequest {
  return new NextRequest("http://hub.local/api/ingest/v1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    source_id: "src-1",
    agent_id: "agent-1",
    session_id: "session-1",
    event_type: "tool_call",
    tool_name: "Read",
    summary: null,
    content: null,
    files_affected: null,
    agent_project: "proj",
    agent_entrypoint: "cli",
    agent_cwd: "/tmp",
    provider: "anthropic",
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

// `null` means "send no Authorization header" — an explicit undefined would
// fall back to the default parameter and silently authenticate the request.
async function ingestBatch(body: unknown, token: string | null = TOKEN) {
  const res = await ingest.POST(post(body, token));
  return { status: res.status, json: await res.json() };
}

describe("POST /api/ingest/v1 — auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const { status, json } = await ingestBatch({ machine_id: "m1", events: [event()] }, null);
    expect(status).toBe(401);
    expect(json.success).toBe(false);
    expect((db.getDb().prepare("SELECT COUNT(*) n FROM agent_events").get() as { n: number }).n).toBe(0);
  });

  it("rejects a wrong bearer token", async () => {
    const { status } = await ingestBatch({ machine_id: "m1", events: [event()] }, "not-the-token");
    expect(status).toBe(401);
  });

  it("refuses everything with 503 when INGEST_TOKEN is unset — a hub must not accept anonymous writes", async () => {
    delete process.env.INGEST_TOKEN;
    const { status, json } = await ingestBatch({ machine_id: "m1", events: [event()] }, TOKEN);
    expect(status).toBe(503);
    expect(json.error.code).toBe("INGEST_DISABLED");
  });

  it("accepts a batch with the right token", async () => {
    const { status, json } = await ingestBatch({ machine_id: "m1", label: "Henry's laptop", events: [event()] });
    expect(status).toBe(200);
    expect(json).toEqual({ success: true, data: { machine_id: "m1", accepted: 1, duplicates: 0 } });

    const row = db.getDb().prepare("SELECT machine_id, session_id, tool_name, provider FROM agent_events").get() as Record<string, string>;
    expect(row).toMatchObject({ machine_id: "m1", session_id: "session-1", tool_name: "Read", provider: "anthropic" });
  });
});

describe("POST /api/ingest/v1 — validation", () => {
  it("400s without a machine_id", async () => {
    const { status } = await ingestBatch({ events: [event()] });
    expect(status).toBe(400);
  });

  it("400s on a machine_id with characters that don't belong in a key", async () => {
    const { status } = await ingestBatch({ machine_id: "bad id/../x", events: [event()] });
    expect(status).toBe(400);
  });

  it("400s when events isn't an array", async () => {
    const { status } = await ingestBatch({ machine_id: "m1", events: "nope" });
    expect(status).toBe(400);
  });

  it("400s past the batch cap without writing anything", async () => {
    const events = Array.from({ length: ingest.MAX_BATCH_SIZE + 1 }, (_, i) => event({ source_id: `s-${i}` }));
    const { status, json } = await ingestBatch({ machine_id: "m1", events });
    expect(status).toBe(400);
    expect(json.error.code).toBe("BATCH_TOO_LARGE");
    expect((db.getDb().prepare("SELECT COUNT(*) n FROM agent_events").get() as { n: number }).n).toBe(0);
  });

  it("400s when an event has no source_id — the idempotency key is mandatory", async () => {
    const { status, json } = await ingestBatch({ machine_id: "m1", events: [event({ source_id: undefined })] });
    expect(status).toBe(400);
    expect(json.error.message).toContain("source_id");
  });

  it("rejects the whole batch when one event is malformed, before writing any of it", async () => {
    const events = [event({ source_id: "ok-1" }), event({ source_id: "bad", agent_id: "" })];
    const { status } = await ingestBatch({ machine_id: "m1", events });
    expect(status).toBe(400);
    expect((db.getDb().prepare("SELECT COUNT(*) n FROM agent_events").get() as { n: number }).n).toBe(0);
  });
});

describe("POST /api/ingest/v1 — idempotency", () => {
  it("counts a replayed source_id as a duplicate instead of inserting it twice", async () => {
    const batch = { machine_id: "m1", events: [event({ source_id: "dup-1" }), event({ source_id: "dup-2" })] };

    const first = await ingestBatch(batch);
    expect(first.json.data).toEqual({ machine_id: "m1", accepted: 2, duplicates: 0 });

    const replay = await ingestBatch(batch);
    expect(replay.json.data).toEqual({ machine_id: "m1", accepted: 0, duplicates: 2 });

    expect((db.getDb().prepare("SELECT COUNT(*) n FROM agent_events").get() as { n: number }).n).toBe(2);
  });

  it("doesn't re-run lifecycle side effects on a replay (no second subagent row)", async () => {
    const batch = {
      machine_id: "m1",
      events: [
        event({ source_id: "start", event_type: "session_start" }),
        event({ source_id: "spawn", event_type: "subagent_start", content: JSON.stringify({ subagent_type: "Explore", description: "look around" }) }),
      ],
    };

    await ingestBatch(batch);
    await ingestBatch(batch);

    const subagents = db.getDb().prepare("SELECT COUNT(*) n FROM agents WHERE type = 'subagent'").get() as { n: number };
    expect(subagents.n).toBe(1);
  });

  it("treats the same source_id from a different machine as a new event", async () => {
    await ingestBatch({ machine_id: "m1", events: [event({ source_id: "shared" })] });
    const second = await ingestBatch({ machine_id: "m2", events: [event({ source_id: "shared" })] });

    expect(second.json.data).toEqual({ machine_id: "m2", accepted: 1, duplicates: 0 });
    expect((db.getDb().prepare("SELECT COUNT(*) n FROM agent_events").get() as { n: number }).n).toBe(2);
  });
});

describe("multi-machine isolation", () => {
  it("keeps two machines' rows apart when they report the same session and agent ids", async () => {
    await ingestBatch({
      machine_id: "mac-mini",
      label: "Mac mini",
      events: [event({ source_id: "a1", event_type: "session_start" }), event({ source_id: "a2" })],
    });
    await ingestBatch({
      machine_id: "laptop",
      label: "Laptop",
      events: [event({ source_id: "b1", event_type: "session_start" }), event({ source_id: "b2" })],
    });

    const d = db.getDb();
    const sessions = d.prepare("SELECT machine_id, machine_label FROM sessions WHERE id = ? ORDER BY machine_id").all("session-1") as { machine_id: string; machine_label: string }[];
    expect(sessions).toEqual([
      { machine_id: "laptop", machine_label: "Laptop" },
      { machine_id: "mac-mini", machine_label: "Mac mini" },
    ]);

    const agents = d.prepare("SELECT machine_id FROM agents WHERE id = ? ORDER BY machine_id").all("agent-1") as { machine_id: string }[];
    expect(agents.map(a => a.machine_id)).toEqual(["laptop", "mac-mini"]);

    // Aggregates stay per-machine rather than folding both into one row
    const rows = db.listSessions(10);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.session_id).toBe("session-1");
      expect(row.event_count).toBe(2);
      expect(row.agent_count).toBe(1);
    }
  });

  it("stamps the unauthenticated local monitor path as machine 'local', alongside a remote machine using the same session id", async () => {
    await ingestBatch({ machine_id: "laptop", events: [event({ source_id: "r1", event_type: "session_start" })] });

    const localReq = new NextRequest("http://127.0.0.1:3000/api/monitor/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent-1", session_id: "session-1", event_type: "session_start", agent_project: "proj" }),
    });
    const res = await monitorEvents.POST(localReq);
    expect(res.status).toBe(201);
    expect((await res.json()).data.machine_id).toBe("local");

    const ids = db.getDb().prepare("SELECT machine_id FROM sessions WHERE id = ? ORDER BY machine_id").all("session-1") as { machine_id: string }[];
    expect(ids.map(r => r.machine_id)).toEqual(["laptop", "local"]);
  });
});

describe("GET /api/machines", () => {
  it("lists every machine the hub has heard from, with its label and last activity", async () => {
    await ingestBatch({ machine_id: "mac-mini", label: "Mac mini", events: [event({ source_id: "m-1", timestamp: 1000 })] });
    await ingestBatch({ machine_id: "laptop", label: "Laptop", events: [event({ source_id: "l-1", timestamp: 2000 })] });

    const res = await machines.GET();
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.map((m: { id: string }) => m.id).sort()).toEqual(["laptop", "mac-mini"]);
    for (const machine of json.data) {
      expect(machine.label).toBe(machine.id === "laptop" ? "Laptop" : "Mac mini");
      expect(machine.last_seen_at).toBeGreaterThan(0);
    }
  });

  it("returns an empty list on a hub that has never been written to", async () => {
    const res = await machines.GET();
    expect((await res.json()).data).toEqual([]);
  });
});
