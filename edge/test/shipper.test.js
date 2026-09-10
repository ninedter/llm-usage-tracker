import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { postBatch, flushOnce, buildBatchBody, buildHeaders, nextBackoffMs, OK, AUTH, RETRY, DROP } from "../src/shipper.js";
import { Queue } from "../src/queue.js";
import { normalizeEvent } from "../src/event.js";
import { createLogger } from "../src/log.js";
import { tempDir, testConfig, mockFetch, collectingSink, TEST_TOKEN } from "./helpers.js";

function ev(i) {
  return normalizeEvent({
    agent_id: "agent-1",
    session_id: "session-1",
    event_type: "tool_call",
    tool_name: `T${i}`,
    timestamp: 1_700_000_000_000 + i,
  });
}

function queueWith(t, count, opts = {}) {
  const dir = tempDir(t);
  const q = new Queue({ path: path.join(dir, "queue.jsonl"), ...opts }).load();
  for (let i = 0; i < count; i++) q.enqueue(ev(i));
  return q;
}

function hubOk(accepted, duplicates = 0) {
  return { status: 200, body: { success: true, data: { machine_id: "grok-bot-box", accepted, duplicates } } };
}

describe("request shape", () => {
  test("posts to /api/ingest/v1 with the bearer token", async () => {
    const config = testConfig();
    const fetch = mockFetch(hubOk(1));
    await postBatch(config, [ev(1)], { fetch });

    const [call] = fetch.calls;
    assert.equal(call.url, "http://henrys-mac-mini:3789/api/ingest/v1");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers.authorization, `Bearer ${TEST_TOKEN}`);
    assert.equal(call.init.headers["content-type"], "application/json");
  });

  test("body matches the hub contract exactly", () => {
    const event = ev(1);
    const body = buildBatchBody(testConfig(), [event]);
    assert.deepEqual(body, {
      machine_id: "grok-bot-box",
      label: "Grok Bot box",
      events: [event],
    });
    assert.equal(typeof body.events[0].source_id, "string");
    assert.ok(body.events[0].source_id, "source_id is required by the hub");
  });

  test("omits label when the machine has none", () => {
    assert.equal("label" in buildBatchBody(testConfig({ machineLabel: null }), []), false);
  });

  test("the auth header is the only place the token appears", () => {
    const config = testConfig();
    const headers = buildHeaders(config);
    const serialized = JSON.stringify(buildBatchBody(config, [ev(1)]));
    assert.equal(headers.authorization.includes(TEST_TOKEN), true);
    assert.equal(serialized.includes(TEST_TOKEN), false);
  });
});

describe("flushOnce chunking", () => {
  test("never sends more than the hub's batch cap in one request", async (t) => {
    const q = queueWith(t, 1_201, { maxEvents: 5_000 });
    const fetch = mockFetch(hubOk(500));
    const summary = await flushOnce(q, testConfig({ batchSize: 500 }), { fetch });

    assert.deepEqual(fetch.calls.map((c) => c.body.events.length), [500, 500, 201]);
    assert.equal(summary.batches, 3);
    assert.equal(q.size(), 0);
  });

  test("ships every event exactly once across the chunks", async (t) => {
    const q = queueWith(t, 1_201, { maxEvents: 5_000 });
    const fetch = mockFetch(hubOk(500));
    await flushOnce(q, testConfig({ batchSize: 500 }), { fetch });

    const ids = fetch.calls.flatMap((c) => c.body.events.map((e) => e.source_id));
    assert.equal(ids.length, 1_201);
    assert.equal(new Set(ids).size, 1_201);
  });

  test("counts hub-reported duplicates as shipped", async (t) => {
    const q = queueWith(t, 2);
    const fetch = mockFetch({ status: 200, body: { success: true, data: { accepted: 0, duplicates: 2 } } });
    const summary = await flushOnce(q, testConfig(), { fetch });
    assert.equal(summary.duplicates, 2);
    assert.equal(q.size(), 0);
  });
});

describe("flushOnce failure handling", () => {
  test("keeps everything queued when the hub is unreachable", async (t) => {
    const q = queueWith(t, 3);
    const fetch = mockFetch(new Error("ECONNREFUSED"));
    const summary = await flushOnce(q, testConfig(), { fetch });

    assert.equal(summary.stopped, RETRY);
    assert.equal(q.size(), 3, "an offline hub must not lose events");
  });

  test("keeps everything queued and stops on a bad token", async (t) => {
    const q = queueWith(t, 3);
    const fetch = mockFetch({ status: 401, body: { success: false, error: { code: "UNAUTHORIZED", message: "Missing or invalid ingest token" } } });
    const summary = await flushOnce(q, testConfig(), { fetch });

    assert.equal(summary.stopped, AUTH);
    assert.equal(fetch.calls.length, 1, "no point hammering the hub with a token it rejects");
    assert.equal(q.size(), 3);
  });

  test("retries on 503 — the hub simply has no INGEST_TOKEN yet", async (t) => {
    const q = queueWith(t, 1);
    const fetch = mockFetch({ status: 503, body: { success: false, error: { code: "INGEST_DISABLED", message: "Ingest is not configured" } } });
    const summary = await flushOnce(q, testConfig(), { fetch });
    assert.equal(summary.stopped, RETRY);
    assert.equal(q.size(), 1);
  });

  test("drops a batch the hub calls invalid instead of wedging the queue behind it", async (t) => {
    const q = queueWith(t, 3);
    const fetch = mockFetch([
      { status: 400, body: { success: false, error: { code: "INVALID_INPUT", message: "events[0]: source_id is required" } } },
      hubOk(0),
    ]);
    const sink = collectingSink();
    const summary = await flushOnce(q, testConfig({ batchSize: 2 }), { fetch, log: createLogger({ secrets: [TEST_TOKEN], sink }) });

    assert.equal(summary.dropped, 2);
    assert.equal(q.size(), 0, "the rest of the queue still ships");
    assert.match(sink.text(), /rejected a batch as invalid/);
  });

  test("resumes from where it stopped on the next flush", async (t) => {
    const q = queueWith(t, 4);
    const failing = mockFetch(new Error("network down"));
    await flushOnce(q, testConfig({ batchSize: 2 }), { fetch: failing });
    assert.equal(q.size(), 4);

    const ok = mockFetch(hubOk(2));
    await flushOnce(q, testConfig({ batchSize: 2 }), { fetch: ok });
    assert.equal(q.size(), 0);
    assert.deepEqual(ok.calls.map((c) => c.body.events.length), [2, 2]);
  });

  test("an empty queue makes no requests", async (t) => {
    const q = queueWith(t, 0);
    const fetch = mockFetch(hubOk(0));
    const summary = await flushOnce(q, testConfig(), { fetch });
    assert.equal(fetch.calls.length, 0);
    assert.equal(summary.batches, 0);
  });
});

describe("postBatch", () => {
  test("classifies hub statuses", async () => {
    const cases = [[200, OK], [400, DROP], [401, AUTH], [403, AUTH], [500, RETRY], [503, RETRY], [429, RETRY]];
    for (const [status, kind] of cases) {
      const result = await postBatch(testConfig(), [ev(1)], { fetch: mockFetch({ status, body: {} }) });
      assert.equal(result.kind, kind, `status ${status}`);
    }
  });

  test("a request that never answers becomes a retry, not a hang", async () => {
    const config = testConfig({ requestTimeoutMs: 20 });
    const hang = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
    const result = await postBatch(config, [ev(1)], { fetch: hang });
    assert.equal(result.kind, RETRY);
    assert.match(result.message, /timed out/);
  });

  test("survives a hub answer that isn't JSON", async () => {
    const result = await postBatch(testConfig(), [ev(1)], {
      fetch: async () => ({ status: 200, json: async () => { throw new Error("not json"); } }),
    });
    assert.equal(result.kind, OK);
    assert.equal(result.accepted, 0);
  });
});

describe("nextBackoffMs", () => {
  test("grows exponentially and caps", () => {
    const config = testConfig({ backoffBaseMs: 1_000, backoffMaxMs: 60_000 });
    const noJitter = () => 0.5;
    assert.equal(nextBackoffMs(1, config, noJitter), 1_000);
    assert.equal(nextBackoffMs(2, config, noJitter), 2_000);
    assert.equal(nextBackoffMs(5, config, noJitter), 16_000);
    assert.equal(nextBackoffMs(50, config, noJitter), 60_000);
  });

  test("jitter stays inside ±20% and never exceeds the cap", () => {
    const config = testConfig({ backoffBaseMs: 1_000, backoffMaxMs: 60_000 });
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const delay = nextBackoffMs(3, config, () => r);
      assert.ok(delay >= 3_200 && delay <= 4_800, `${delay} within jitter band`);
      assert.ok(nextBackoffMs(99, config, () => r) <= 60_000);
    }
  });
});
