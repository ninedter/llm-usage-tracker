import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Queue } from "../src/queue.js";
import { normalizeEvent } from "../src/event.js";
import { tempDir } from "./helpers.js";

function ev(overrides = {}) {
  return normalizeEvent({
    agent_id: "agent-1",
    session_id: "session-1",
    event_type: "tool_call",
    tool_name: "Read",
    timestamp: 1_700_000_000_000,
    ...overrides,
  });
}

function openQueue(t, opts = {}) {
  const dir = tempDir(t);
  return new Queue({ path: path.join(dir, "spool", "queue.jsonl"), ...opts }).load();
}

describe("Queue idempotency", () => {
  test("the same source_id is queued once, however many times it arrives", (t) => {
    const q = openQueue(t);
    const event = ev();
    assert.deepEqual(q.enqueue(event), { queued: true, duplicate: false, source_id: event.source_id });
    assert.deepEqual(q.enqueue({ ...event }), { queued: false, duplicate: true, source_id: event.source_id });
    assert.equal(q.size(), 1);
  });

  test("two different events are both queued", (t) => {
    const q = openQueue(t);
    q.enqueue(ev({ tool_name: "Read" }));
    q.enqueue(ev({ tool_name: "Write" }));
    assert.equal(q.size(), 2);
  });

  test("a shipped source_id is still recognised as a duplicate afterwards", (t) => {
    const q = openQueue(t);
    const event = ev();
    q.enqueue(event);
    q.ack([event.source_id]);
    assert.equal(q.size(), 0);
    assert.equal(q.enqueue(event).duplicate, true);
    assert.equal(q.size(), 0);
  });

  test("the recently-shipped set stays bounded", (t) => {
    const q = openQueue(t, { recentIds: 3 });
    for (let i = 0; i < 10; i++) {
      const event = ev({ tool_name: `T${i}` });
      q.enqueue(event);
      q.ack([event.source_id]);
    }
    assert.equal(q.recentIds.size, 3);
  });
});

describe("Queue durability", () => {
  test("events survive a restart and keep their order", (t) => {
    const dir = tempDir(t);
    const spool = path.join(dir, "spool", "queue.jsonl");
    const first = new Queue({ path: spool }).load();
    first.enqueue(ev({ tool_name: "Read" }));
    first.enqueue(ev({ tool_name: "Write" }));

    const reopened = new Queue({ path: spool }).load();
    assert.equal(reopened.size(), 2);
    assert.deepEqual(reopened.peek(2).map((e) => e.tool_name), ["Read", "Write"]);
  });

  test("ack rewrites the spool so shipped events don't come back after a restart", (t) => {
    const dir = tempDir(t);
    const spool = path.join(dir, "spool", "queue.jsonl");
    const q = new Queue({ path: spool }).load();
    const a = ev({ tool_name: "Read" });
    const b = ev({ tool_name: "Write" });
    q.enqueue(a);
    q.enqueue(b);
    q.ack([a.source_id]);

    const reopened = new Queue({ path: spool }).load();
    assert.equal(reopened.size(), 1);
    assert.equal(reopened.peek(1)[0].tool_name, "Write");
  });

  test("a half-written trailing line is skipped, not fatal", (t) => {
    const dir = tempDir(t);
    const spool = path.join(dir, "spool", "queue.jsonl");
    const q = new Queue({ path: spool }).load();
    q.enqueue(ev({ tool_name: "Read" }));
    fs.appendFileSync(spool, '{"source_id":"truncated","event":{"agen');

    const dropped = [];
    const reopened = new Queue({ path: spool, onDrop: (d) => dropped.push(d) }).load();
    assert.equal(reopened.size(), 1);
    assert.deepEqual(dropped, [{ reason: "malformed_line", count: 1 }]);
  });
});

describe("Queue cap", () => {
  test("drops the oldest events once the cap is hit, keeping the newest", (t) => {
    const dropped = [];
    const q = openQueue(t, { maxEvents: 3, onDrop: (d) => dropped.push(d) });
    for (let i = 0; i < 5; i++) q.enqueue(ev({ tool_name: `T${i}` }));

    assert.equal(q.size(), 3);
    assert.deepEqual(q.peek(3).map((e) => e.tool_name), ["T2", "T3", "T4"]);
    assert.equal(dropped.reduce((n, d) => n + d.count, 0), 2);
    assert.equal(q.stats().dropped_total, 2);
  });

  test("a capped spool converges on the same events after a restart", (t) => {
    const dir = tempDir(t);
    const spool = path.join(dir, "queue.jsonl");
    const q = new Queue({ path: spool, maxEvents: 3 }).load();
    for (let i = 0; i < 200; i++) q.enqueue(ev({ tool_name: `T${i}` }));

    const reopened = new Queue({ path: spool, maxEvents: 3 }).load();
    assert.deepEqual(reopened.peek(3).map((e) => e.tool_name), q.peek(3).map((e) => e.tool_name));
    assert.equal(reopened.size(), 3);
  });

  test("compaction is batched, so a long offline stretch isn't quadratic", (t) => {
    const dir = tempDir(t);
    const spool = path.join(dir, "queue.jsonl");
    const q = new Queue({ path: spool, maxEvents: 5 }).load();
    for (let i = 0; i < 60; i++) q.enqueue(ev({ tool_name: `T${i}` }));

    // 55 events over the cap, well under the 100-drop compaction threshold:
    // the spool still holds every line, memory holds only the newest 5.
    assert.equal(q.size(), 5);
    assert.equal(fs.readFileSync(spool, "utf8").trim().split("\n").length, 60);
    assert.equal(new Queue({ path: spool, maxEvents: 5 }).load().size(), 5);
  });
});
