import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createEdgeAgent } from "../src/agent.js";
import { createLogger } from "../src/log.js";
import { tempDir, testConfig, mockFetch, collectingSink, TEST_TOKEN } from "./helpers.js";

/** Exactly the body hooks/agent-monitor-hook.py posts for a PreToolUse event. */
const HOOK_BODY = {
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
};

async function startAgent(t, { fetch = mockFetch({ status: 200, body: { success: true, data: { accepted: 1, duplicates: 0 } } }), configOverrides = {} } = {}) {
  const dir = tempDir(t);
  const sink = collectingSink();
  const config = testConfig({ spoolPath: path.join(dir, "spool", "queue.jsonl"), intakePort: 0, ...configOverrides });
  const log = createLogger({ secrets: [config.token], sink, level: "debug" });
  const agent = createEdgeAgent({ config, log, fetch });
  await agent.start();
  t.after(() => agent.stop());
  const { port } = agent.server.address();
  const url = (p) => `http://127.0.0.1:${port}${p}`;
  const post = (p, body) => globalThis.fetch(url(p), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { agent, config, url, post, fetch, sink, get: (p) => globalThis.fetch(url(p)) };
}

describe("intake", () => {
  test("accepts the existing hook's POST /api/monitor/events unchanged", async (t) => {
    const { post, agent } = await startAgent(t);
    const res = await post("/api/monitor/events", HOOK_BODY);

    assert.equal(res.status, 202, "the hook gets an immediate ack and exits 0");
    assert.deepEqual((await res.json()).data, { accepted: 1, duplicates: 0, rejected: [] });
    assert.equal(agent.queue.size(), 1);
  });

  test("accepts a batch on /v1/events", async (t) => {
    const { post, agent } = await startAgent(t);
    const res = await post("/v1/events", { events: [HOOK_BODY, { ...HOOK_BODY, tool_name: "Read" }] });
    assert.equal((await res.json()).data.accepted, 2);
    assert.equal(agent.queue.size(), 2);
  });

  test("the event is on disk before the hook is answered", async (t) => {
    const { post, config } = await startAgent(t);
    await post("/api/monitor/events", { ...HOOK_BODY, source_id: "hook:1" });

    const lines = fs.readFileSync(config.spoolPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).source_id, "hook:1");
  });

  test("a replayed hook post is deduped locally", async (t) => {
    const { post, agent } = await startAgent(t);
    await post("/api/monitor/events", { ...HOOK_BODY, timestamp: 1_700_000_000_000 });
    const second = await post("/api/monitor/events", { ...HOOK_BODY, timestamp: 1_700_000_000_000 });

    assert.deepEqual((await second.json()).data, { accepted: 0, duplicates: 1, rejected: [] });
    assert.equal(agent.queue.size(), 1);
  });

  test("a malformed event is reported, not crashed on", async (t) => {
    const { post, agent } = await startAgent(t);
    const res = await post("/v1/events", { events: [{ nothing: true }, HOOK_BODY] });
    const { data } = await res.json();

    assert.equal(res.status, 202);
    assert.equal(data.accepted, 1);
    assert.deepEqual(data.rejected, [{ index: 0, reason: "agent_id is required" }]);
    assert.equal(agent.queue.size(), 1);
  });

  test("non-JSON gets a 400 and queues nothing", async (t) => {
    const { post, agent } = await startAgent(t);
    const res = await post("/api/monitor/events", "not json at all");
    assert.equal(res.status, 400);
    assert.equal(agent.queue.size(), 0);
  });

  test("unknown routes 404", async (t) => {
    const { get } = await startAgent(t);
    assert.equal((await get("/nope")).status, 404);
  });

  test("/health reports queue depth", async (t) => {
    const { get, post } = await startAgent(t);
    await post("/api/monitor/events", HOOK_BODY);
    const body = await (await get("/health")).json();
    assert.deepEqual(body.data, { ok: true, machine_id: "grok-bot-box", queued: 1 });
  });

  test("/status never returns the token", async (t) => {
    const { get } = await startAgent(t);
    const text = await (await get("/status")).text();
    assert.equal(text.includes(TEST_TOKEN), false);
    assert.match(text, /\*\*\*set\*\*\*/);
    assert.match(text, /grok-bot-box/);
  });
});

describe("hook -> edge -> hub", () => {
  test("a hook event ends up as a correctly shaped hub batch", async (t) => {
    const hub = mockFetch({ status: 200, body: { success: true, data: { accepted: 1, duplicates: 0 } } });
    const { post, agent } = await startAgent(t, { fetch: hub });

    await post("/api/monitor/events", { ...HOOK_BODY, timestamp: 1_700_000_000_000 });
    await agent.flush();

    assert.equal(hub.calls.length, 1);
    const call = hub.calls[0];
    assert.equal(call.url, "http://henrys-mac-mini:3789/api/ingest/v1");
    assert.equal(call.init.headers.authorization, `Bearer ${TEST_TOKEN}`);
    assert.equal(call.body.machine_id, "grok-bot-box");
    assert.equal(call.body.label, "Grok Bot box");
    assert.deepEqual(call.body.events[0], {
      source_id: call.body.events[0].source_id,
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
      provider: "anthropic",
      timestamp: 1_700_000_000_000,
    });
    assert.ok(call.body.events[0].source_id, "the hub requires a stable source_id");
    assert.equal(agent.queue.size(), 0);
  });

  test("events survive an offline hub and ship when it comes back", async (t) => {
    let online = false;
    const fetch = mockFetch(async () => {
      if (!online) throw new Error("ECONNREFUSED");
      return { status: 200, json: async () => ({ success: true, data: { accepted: 2, duplicates: 0 } }) };
    });
    const { post, agent, config } = await startAgent(t, { fetch });

    await post("/api/monitor/events", HOOK_BODY);
    await post("/api/monitor/events", { ...HOOK_BODY, tool_name: "Read" });
    await agent.flush();
    assert.equal(agent.queue.size(), 2, "nothing is lost while the hub is unreachable");
    assert.equal(fs.readFileSync(config.spoolPath, "utf8").trim().split("\n").length, 2);

    online = true;
    await agent.flush();
    assert.equal(agent.queue.size(), 0);
    assert.equal(fs.readFileSync(config.spoolPath, "utf8").trim(), "");
  });

  test("a queued backlog is drained in hub-sized batches", async (t) => {
    const hub = mockFetch({ status: 200, body: { success: true, data: { accepted: 100, duplicates: 0 } } });
    const { post, agent } = await startAgent(t, { fetch: hub, configOverrides: { batchSize: 100, maxQueueEvents: 5_000 } });

    const events = Array.from({ length: 250 }, (_, i) => ({ ...HOOK_BODY, tool_name: `T${i}`, timestamp: 1_700_000_000_000 + i }));
    await post("/v1/events", { events });
    await agent.flush();

    assert.deepEqual(hub.calls.map((c) => c.body.events.length), [100, 100, 50]);
    assert.equal(agent.queue.size(), 0);
  });

  test("nothing the edge logs contains the token", async (t) => {
    const hub = mockFetch({ status: 401, body: { success: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid ingest token" } } });
    const { post, agent, sink } = await startAgent(t, { fetch: hub });

    await post("/api/monitor/events", HOOK_BODY);
    await agent.flush();

    assert.equal(sink.text().includes(TEST_TOKEN), false);
    assert.match(sink.text(), /rejected the ingest token/);
  });
});
