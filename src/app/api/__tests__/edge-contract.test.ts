import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
// The edge ships as its own zero-dependency Node package (see edge/README.md).
// It is imported here on purpose: this suite is the contract test between the
// two halves — if the hub's ingest route ever tightens what it accepts, the
// batch the edge actually builds has to keep passing it.
import { buildBatchBody, buildHeaders } from "../../../../edge/src/shipper.js";
import { normalizeEvent } from "../../../../edge/src/event.js";

let tmpDir: string;
let db: typeof import("@/lib/db");
let ingest: typeof import("@/app/api/ingest/v1/route");

const TOKEN = "contract-test-token";
const EDGE_CONFIG = {
  machineId: "grok-bot-box",
  machineLabel: "Grok Bot box",
  token: TOKEN,
  ingestUrl: "http://henrys-mac-mini:3789/api/ingest/v1",
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "edge-contract-test-"));
  process.env.LLM_DATA_DIR = tmpDir;
  process.env.INGEST_TOKEN = TOKEN;
  db = await import("@/lib/db");
  ingest = await import("@/app/api/ingest/v1/route");
});

afterAll(() => {
  delete process.env.INGEST_TOKEN;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  const d = db.getDb();
  for (const t of ["agent_events", "agents", "token_usage", "sessions", "daily_usage"]) {
    d.prepare(`DELETE FROM ${t}`).run();
  }
});

/** The body Claude Code's hook posts, verbatim from agent-monitor-hook.py's build_body(). */
function hookBody(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: "sess-abc",
    session_id: "sess-abc",
    event_type: "tool_call",
    tool_name: "Bash",
    summary: "npm test",
    content: '{"command":"npm test"}',
    files_affected: ["/workspace/app/package.json"],
    agent_project: "app",
    agent_entrypoint: "cli",
    agent_cwd: "/workspace/app",
    ...overrides,
  };
}

/** Exactly what the edge's flusher sends: same body builder, same headers. */
async function shipLikeEdge(hookBodies: Record<string, unknown>[]) {
  const events = hookBodies.map((raw) => normalizeEvent(raw));
  const req = new NextRequest(EDGE_CONFIG.ingestUrl, {
    method: "POST",
    headers: buildHeaders(EDGE_CONFIG),
    body: JSON.stringify(buildBatchBody(EDGE_CONFIG, events)),
  });
  const res = await ingest.POST(req);
  return { status: res.status, json: await res.json(), events };
}

describe("edge -> hub ingest contract", () => {
  it("a batch built by the edge is accepted by the hub as-is", async () => {
    const { status, json } = await shipLikeEdge([hookBody({ event_type: "session_start" }), hookBody()]);

    expect(status).toBe(200);
    expect(json).toEqual({ success: true, data: { machine_id: "grok-bot-box", accepted: 2, duplicates: 0 } });

    const row = db.getDb()
      .prepare("SELECT machine_id, session_id, event_type, tool_name, provider FROM agent_events WHERE event_type = 'tool_call'")
      .get() as Record<string, string>;
    expect(row).toMatchObject({ machine_id: "grok-bot-box", session_id: "sess-abc", event_type: "tool_call", tool_name: "Bash", provider: "anthropic" });
  });

  it("the machine label the edge sends lands on the session row", async () => {
    await shipLikeEdge([hookBody({ event_type: "session_start" })]);
    const session = db.getDb().prepare("SELECT machine_id, machine_label FROM sessions").get() as Record<string, string>;
    expect(session).toEqual({ machine_id: "grok-bot-box", machine_label: "Grok Bot box" });
  });

  it("the derived source_id makes a replayed batch idempotent — the offline-retry case", async () => {
    const bodies = [hookBody({ timestamp: 1_700_000_000_000 }), hookBody({ timestamp: 1_700_000_000_001 })];
    const first = await shipLikeEdge(bodies);
    expect(first.json.data).toEqual({ machine_id: "grok-bot-box", accepted: 2, duplicates: 0 });

    const replay = await shipLikeEdge(bodies);
    expect(replay.json.data).toEqual({ machine_id: "grok-bot-box", accepted: 0, duplicates: 2 });
    expect((db.getDb().prepare("SELECT COUNT(*) n FROM agent_events").get() as { n: number }).n).toBe(2);
  });

  it("a full edge batch is exactly the size the hub allows", async () => {
    const bodies = Array.from({ length: ingest.MAX_BATCH_SIZE }, (_, i) => hookBody({ timestamp: 1_700_000_000_000 + i }));
    const { status, json } = await shipLikeEdge(bodies);
    expect(status).toBe(200);
    expect(json.data.accepted).toBe(ingest.MAX_BATCH_SIZE);
  });

  it("the hub still refuses an edge batch sent without the bearer token", async () => {
    const events = [normalizeEvent(hookBody())];
    const req = new NextRequest(EDGE_CONFIG.ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBatchBody(EDGE_CONFIG, events)),
    });
    expect((await ingest.POST(req)).status).toBe(401);
  });
});
