import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "llm-edge-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const TEST_TOKEN = "super-secret-ingest-token-abc123";

export function testConfig(overrides = {}) {
  return {
    trackerUrl: "http://henrys-mac-mini:3789",
    ingestUrl: "http://henrys-mac-mini:3789/api/ingest/v1",
    machineId: "grok-bot-box",
    machineLabel: "Grok Bot box",
    token: TEST_TOKEN,
    intakeHost: "127.0.0.1",
    intakePort: 0,
    flushIntervalMs: 50,
    batchSize: 500,
    maxQueueEvents: 1000,
    backoffBaseMs: 10,
    backoffMaxMs: 100,
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

/** A fetch double that records every call and replays scripted responses. */
export function mockFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const next = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : responses;
    if (typeof next === "function") return next(url, init);
    if (next instanceof Error) throw next;
    return {
      status: next.status ?? 200,
      json: async () => next.body ?? { success: true, data: { machine_id: "grok-bot-box", accepted: 0, duplicates: 0 } },
    };
  };
  fn.calls = calls;
  return fn;
}

/** Collects log lines so a test can assert on what would have hit stdout. */
export function collectingSink() {
  const lines = [];
  const sink = (line) => lines.push(line);
  sink.lines = lines;
  sink.text = () => lines.join("\n");
  return sink;
}
