import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";

let db: typeof import("@/lib/db");
let storageRoute: typeof import("@/app/api/monitor/storage/route");
let retentionRoute: typeof import("@/app/api/monitor/retention/route");
let purgeRoute: typeof import("@/app/api/monitor/purge/route");

beforeAll(async () => {
  process.env.LLM_DATA_DIR = mkdtempSync(join(tmpdir(), "purge-routes-"));
  db = await import("@/lib/db");
  storageRoute = await import("@/app/api/monitor/storage/route");
  retentionRoute = await import("@/app/api/monitor/retention/route");
  purgeRoute = await import("@/app/api/monitor/purge/route");
});

function clearAll() {
  const d = db.getDb();
  for (const t of ["agent_events", "agents", "token_usage", "sessions", "daily_usage", "app_settings"]) {
    d.prepare(`DELETE FROM ${t}`).run();
  }
}
beforeEach(() => clearAll());

function seedSession(id: string, startedAt: number) {
  db.getDb()
    .prepare("INSERT INTO sessions (id,status,project,cwd,entrypoint,started_at,ended_at,updated_at,metadata) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "completed", "p", "", "cli", startedAt, null, startedAt, null);
}

describe("GET /api/monitor/storage", () => {
  it("returns table counts", async () => {
    seedSession("a", 1000);
    const res = await storageRoute.GET();
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.counts.sessions).toBe(1);
  });
});

describe("/api/monitor/retention", () => {
  it("PUT then GET round-trips the policy", async () => {
    const putReq = new NextRequest("http://x/api/monitor/retention", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, days: 14 }),
      headers: { "Content-Type": "application/json" },
    });
    const putJson = await (await retentionRoute.PUT(putReq)).json();
    expect(putJson.data.enabled).toBe(true);
    expect(putJson.data.days).toBe(14);

    const getJson = await (await retentionRoute.GET()).json();
    expect(getJson.data.enabled).toBe(true);
    expect(getJson.data.days).toBe(14);
  });

  it("GET returns defaults on a fresh DB", async () => {
    const json = await (await retentionRoute.GET()).json();
    expect(json.data).toEqual({ enabled: false, days: 30, last_purge_at: null });
  });

  it("PUT ignores fractional/invalid days and non-boolean enabled", async () => {
    const req = new NextRequest("http://x/api/monitor/retention", {
      method: "PUT",
      body: JSON.stringify({ days: 0.5, enabled: "yes" }),
      headers: { "Content-Type": "application/json" },
    });
    const json = await (await retentionRoute.PUT(req)).json();
    expect(json.data.days).toBe(30);       // fractional rejected → stays default, NOT 0
    expect(json.data.enabled).toBe(false); // non-boolean ignored
  });
});

describe("/api/monitor/purge", () => {
  it("GET previews rows older than the window", async () => {
    seedSession("old", Date.now() - 40 * 86400000);
    seedSession("new", Date.now() - 1 * 86400000);
    const req = new NextRequest("http://x/api/monitor/purge?days=30");
    const json = await (await purgeRoute.GET(req)).json();
    expect(json.success).toBe(true);
    expect(json.data.would_delete.sessions).toBe(1);
  });

  it("POST deletes rows older than the window", async () => {
    seedSession("old", Date.now() - 40 * 86400000);
    seedSession("new", Date.now() - 1 * 86400000);
    const req = new NextRequest("http://x/api/monitor/purge", {
      method: "POST",
      body: JSON.stringify({ days: 30 }),
      headers: { "Content-Type": "application/json" },
    });
    const json = await (await purgeRoute.POST(req)).json();
    expect(json.success).toBe(true);
    expect(json.data.deleted.sessions).toBe(1);
    expect(db.getStorageInfo().counts.sessions).toBe(1); // the newer one remains
  });

  it("POST with days='all' wipes everything, ignoring the cutoff", async () => {
    seedSession("a", 1000);
    seedSession("recent", Date.now()); // a fresh session an age-cutoff would keep
    const req = new NextRequest("http://x/api/monitor/purge", {
      method: "POST",
      body: JSON.stringify({ days: "all" }),
      headers: { "Content-Type": "application/json" },
    });
    const json = await (await purgeRoute.POST(req)).json();
    expect(json.data.deleted.sessions).toBe(2); // both ancient and recent
    expect(db.getStorageInfo().counts.sessions).toBe(0);
  });

  it("POST with an empty body is rejected (400) and deletes nothing", async () => {
    seedSession("keep", Date.now() - 40 * 86400000);
    const req = new NextRequest("http://x/api/monitor/purge", { method: "POST" }); // no body
    const res = await purgeRoute.POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(db.getStorageInfo().counts.sessions).toBe(1); // untouched
  });
});
