import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, deriveSourceId, eventsFromPayload, InvalidEventError, MAX_CONTENT, MAX_SUMMARY } from "../src/event.js";

/** Exactly what hooks/agent-monitor-hook.py's build_body() posts. */
function hookBody(overrides = {}) {
  return {
    agent_id: "sess-abc",
    session_id: "sess-abc",
    event_type: "tool_call",
    tool_name: "Bash",
    summary: "run the tests",
    content: '{"command":"npm test"}',
    files_affected: ["/workspace/app/src/index.ts"],
    agent_project: "app",
    agent_entrypoint: "cli",
    agent_cwd: "/workspace/app",
    ...overrides,
  };
}

describe("normalizeEvent", () => {
  test("turns a hook body into the hub's ingest event shape", () => {
    const event = normalizeEvent(hookBody(), { now: 1_700_000_000_000 });
    assert.deepEqual(Object.keys(event).sort(), [
      "agent_cwd", "agent_entrypoint", "agent_id", "agent_project", "content",
      "event_type", "files_affected", "provider", "session_id", "source_id",
      "summary", "timestamp", "tool_name",
    ]);
    assert.equal(event.provider, "anthropic");
    assert.equal(event.timestamp, 1_700_000_000_000);
    assert.equal(typeof event.source_id, "string");
    assert.ok(event.source_id.length > 0);
  });

  test("requires the two fields every ingest path requires", () => {
    assert.throws(() => normalizeEvent(hookBody({ agent_id: "", session_id: "" })), InvalidEventError);
    assert.throws(() => normalizeEvent(hookBody({ event_type: "" })), InvalidEventError);
    assert.throws(() => normalizeEvent("nope"), InvalidEventError);
  });

  test("falls back to session_id for agent_id, and to agent_id for session_id", () => {
    assert.equal(normalizeEvent({ session_id: "s1", event_type: "stop" }).agent_id, "s1");
    assert.equal(normalizeEvent({ agent_id: "a1", event_type: "stop" }).session_id, "a1");
  });

  test("stamps a timestamp when the hook doesn't send one", () => {
    assert.equal(normalizeEvent(hookBody(), { now: 42_000 }).timestamp, 42_000);
    assert.equal(normalizeEvent(hookBody({ timestamp: 99 })).timestamp, 99);
  });

  test("coerces any provider that isn't one the hub stores", () => {
    assert.equal(normalizeEvent(hookBody({ provider: "openai" })).provider, "openai");
    assert.equal(normalizeEvent(hookBody({ provider: "gemini" })).provider, "anthropic");
    assert.equal(normalizeEvent(hookBody({ provider: undefined })).provider, "anthropic");
  });

  test("normalizes files_affected to an array or null", () => {
    assert.deepEqual(normalizeEvent(hookBody({ files_affected: "/a/b.ts" })).files_affected, ["/a/b.ts"]);
    assert.equal(normalizeEvent(hookBody({ files_affected: [] })).files_affected, null);
    assert.equal(normalizeEvent(hookBody({ files_affected: null })).files_affected, null);
  });

  test("bounds what one event can put in the spool", () => {
    const event = normalizeEvent(hookBody({ summary: "s".repeat(5_000), content: "c".repeat(50_000) }));
    assert.equal(event.summary.length, MAX_SUMMARY);
    assert.equal(event.content.length, MAX_CONTENT);
  });

  test("string fields the hub indexes are never null", () => {
    const event = normalizeEvent({ agent_id: "a1", event_type: "stop" });
    assert.equal(event.agent_project, "");
    assert.equal(event.agent_entrypoint, "");
    assert.equal(event.agent_cwd, "");
  });
});

describe("source_id", () => {
  test("is stable for the same event, so a replay is a duplicate at the hub", () => {
    const a = normalizeEvent(hookBody({ timestamp: 1_000 }));
    const b = normalizeEvent(hookBody({ timestamp: 1_000 }));
    assert.equal(a.source_id, b.source_id);
  });

  test("differs when anything about the event differs", () => {
    const base = normalizeEvent(hookBody({ timestamp: 1_000 }));
    for (const change of [{ timestamp: 1_001 }, { tool_name: "Read" }, { summary: "other" }, { session_id: "other" }]) {
      assert.notEqual(normalizeEvent(hookBody({ timestamp: 1_000, ...change })).source_id, base.source_id);
    }
  });

  test("a caller-supplied source_id always wins", () => {
    assert.equal(normalizeEvent(hookBody({ source_id: "hook:1730000000:1" })).source_id, "hook:1730000000:1");
  });

  test("derives from event content, not from object key order", () => {
    const event = normalizeEvent(hookBody({ timestamp: 1_000 }));
    assert.equal(deriveSourceId(event), deriveSourceId({ ...event }));
  });
});

describe("eventsFromPayload", () => {
  test("accepts a batch and a bare event", () => {
    assert.equal(eventsFromPayload({ events: [1, 2, 3] }).length, 3);
    assert.deepEqual(eventsFromPayload({ agent_id: "a" }), [{ agent_id: "a" }]);
  });
});
