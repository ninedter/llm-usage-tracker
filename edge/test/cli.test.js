import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempDir, TEST_TOKEN } from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/llm-edge.js", import.meta.url));

function run(t, args, extraEnv = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    // No stdin: `send` would otherwise block reading fd 0 in a test runner.
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      EDGE_CONFIG_DIR: tempDir(t),
      MACHINE_ID: "grok-bot-box",
      MACHINE_LABEL: "Grok Bot box",
      INGEST_TOKEN: TEST_TOKEN,
      // An intake port nothing listens on, so `send`/`status` take the
      // no-daemon path instead of talking to a real edge on the test machine.
      INTAKE_PORT: "1",
      ...extraEnv,
    },
  });
}

describe("llm-edge CLI", () => {
  test("send --dry-run prints the exact hub request, with the token redacted", (t) => {
    const payload = JSON.parse(run(t, ["send", "--dry-run", "--type", "session_start"]));

    assert.equal(payload.url, "http://henrys-mac-mini:3789/api/ingest/v1");
    assert.equal(payload.headers.authorization, "Bearer [REDACTED]");
    assert.equal(payload.body.machine_id, "grok-bot-box");
    assert.equal(payload.body.label, "Grok Bot box");
    assert.equal(payload.body.events.length, 1);

    const event = payload.body.events[0];
    assert.equal(event.event_type, "session_start");
    assert.equal(event.provider, "anthropic");
    assert.ok(event.source_id, "the hub requires a stable source_id");
    assert.ok(Number.isInteger(event.timestamp));
    assert.equal(JSON.stringify(payload).includes(TEST_TOKEN), false);
  });

  test("send spools the event when no edge is running", (t) => {
    const dir = tempDir(t);
    const out = run(t, ["send", "--json"], { EDGE_CONFIG_DIR: dir });
    const result = JSON.parse(out);
    assert.match(result.via, /spool/);
    assert.equal(result.accepted, 1);
    assert.equal(result.queued, 1);

    const status = JSON.parse(run(t, ["status", "--json"], { EDGE_CONFIG_DIR: dir }));
    assert.equal(status.running, false);
    assert.equal(status.queued, 1);
    assert.equal(status.config.token, "***set***");
  });

  test("config prints the effective config without the token", (t) => {
    const text = run(t, ["config"]);
    assert.equal(text.includes(TEST_TOKEN), false);
    assert.match(text, /machineId\s+grok-bot-box/);
    assert.match(text, /token\s+\*\*\*set\*\*\*/);
  });

  test("start refuses to run without a MACHINE_ID and says which key is missing", (t) => {
    try {
      run(t, ["start"], { MACHINE_ID: "" });
      assert.fail("should have exited non-zero");
    } catch (error) {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /MACHINE_ID is required/);
      assert.equal(error.stderr.includes(TEST_TOKEN), false);
    }
  });

  test("help lists the commands", (t) => {
    assert.match(run(t, ["help"]), /start[\s\S]*status[\s\S]*drain[\s\S]*send/);
  });
});
