import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, configDir, parseEnvFile, isValidMachineId, DEFAULT_TRACKER_URL, DEFAULT_INTAKE_PORT, HUB_MAX_BATCH_SIZE } from "../src/config.js";
import { tempDir, TEST_TOKEN } from "./helpers.js";

function env(t, extra = {}) {
  return { EDGE_CONFIG_DIR: tempDir(t), MACHINE_ID: "grok-bot-box", INGEST_TOKEN: TEST_TOKEN, ...extra };
}

describe("loadConfig defaults", () => {
  test("defaults to the hub over Tailscale and the loopback intake port", (t) => {
    const { config, errors } = loadConfig(env(t));
    assert.deepEqual(errors, []);
    assert.equal(config.trackerUrl, DEFAULT_TRACKER_URL);
    assert.equal(config.ingestUrl, `${DEFAULT_TRACKER_URL}/api/ingest/v1`);
    assert.equal(config.intakePort, DEFAULT_INTAKE_PORT);
    assert.equal(config.intakeHost, "127.0.0.1", "intake must not listen off-box by default");
    assert.equal(config.batchSize, HUB_MAX_BATCH_SIZE);
  });

  test("never sends a batch bigger than the hub accepts", (t) => {
    assert.equal(loadConfig(env(t, { MAX_BATCH_SIZE: "5000" })).config.batchSize, HUB_MAX_BATCH_SIZE);
    assert.equal(loadConfig(env(t, { MAX_BATCH_SIZE: "50" })).config.batchSize, 50);
  });

  test("strips a trailing slash so the ingest URL never doubles up", (t) => {
    assert.equal(loadConfig(env(t, { TRACKER_URL: "http://hub:3789/" })).config.ingestUrl, "http://hub:3789/api/ingest/v1");
  });
});

describe("loadConfig validation", () => {
  test("MACHINE_ID is required and must match the hub's charset", (t) => {
    assert.match(loadConfig(env(t, { MACHINE_ID: "" })).errors.join(), /MACHINE_ID is required/);
    assert.match(loadConfig(env(t, { MACHINE_ID: "bad id/../x" })).errors.join(), /MACHINE_ID must be/);
    assert.deepEqual(loadConfig(env(t, { MACHINE_ID: "henrymacbook-pro" })).errors, []);
  });

  test("INGEST_TOKEN is required, and the error names the key without echoing a value", (t) => {
    const { errors } = loadConfig(env(t, { INGEST_TOKEN: "" }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /INGEST_TOKEN is required/);
  });

  test("rejects a TRACKER_URL that isn't http(s)", (t) => {
    assert.match(loadConfig(env(t, { TRACKER_URL: "ftp://hub" })).errors.join(), /TRACKER_URL/);
    assert.match(loadConfig(env(t, { TRACKER_URL: "not a url" })).errors.join(), /TRACKER_URL/);
  });

  test("errors mention no secret values", (t) => {
    const { errors } = loadConfig({ EDGE_CONFIG_DIR: tempDir(t), MACHINE_ID: "bad id", INGEST_TOKEN: TEST_TOKEN, TRACKER_URL: "ftp://x" });
    assert.equal(errors.join(" ").includes(TEST_TOKEN), false);
  });

  test("isValidMachineId matches the hub's normalizeMachineId rules", () => {
    for (const id of ["grok-bot-box", "henrymacbook-pro", "henrys-mac-mini", "b6b3f0f4-6f1a-4a1e", "host.local:1"]) {
      assert.equal(isValidMachineId(id), true, id);
    }
    for (const id of ["", " ", "has space", "slash/es", "a".repeat(129), 42, null]) {
      assert.equal(isValidMachineId(id), false, String(id));
    }
  });
});

describe("config files", () => {
  test("reads config.json from the config dir", (t) => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ MACHINE_ID: "henrymacbook-pro", MACHINE_LABEL: "Henry's MacBook", INGEST_TOKEN: TEST_TOKEN }));
    const { config, errors } = loadConfig({ EDGE_CONFIG_DIR: dir });
    assert.deepEqual(errors, []);
    assert.equal(config.machineId, "henrymacbook-pro");
    assert.equal(config.machineLabel, "Henry's MacBook");
  });

  test("reads a .env file", (t) => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, ".env"), `# hub\nMACHINE_ID=grok-bot-box\nINGEST_TOKEN="${TEST_TOKEN}"\nTRACKER_URL=http://hub:3789\n`);
    const { config, errors } = loadConfig({ EDGE_CONFIG_DIR: dir });
    assert.deepEqual(errors, []);
    assert.equal(config.machineId, "grok-bot-box");
    assert.equal(config.token, TEST_TOKEN);
  });

  test("the environment beats the file", (t) => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, ".env"), "MACHINE_ID=from-file\n");
    const { config } = loadConfig({ EDGE_CONFIG_DIR: dir, MACHINE_ID: "from-env", INGEST_TOKEN: TEST_TOKEN });
    assert.equal(config.machineId, "from-env");
  });

  test("a corrupt config file doesn't stop an env-configured edge", (t) => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, "config.json"), "{ this is not json");
    const { config, errors } = loadConfig({ EDGE_CONFIG_DIR: dir, MACHINE_ID: "grok-bot-box", INGEST_TOKEN: TEST_TOKEN });
    assert.deepEqual(errors, []);
    assert.equal(config.machineId, "grok-bot-box");
  });

  test("parseEnvFile handles comments, quotes and '=' inside values", () => {
    const parsed = parseEnvFile('# c\nA=1\nB="two"\nC=has=equals\n\nBAD\n');
    assert.deepEqual(parsed, { A: "1", B: "two", C: "has=equals" });
  });
});

describe("paths", () => {
  test("EDGE_CONFIG_DIR wins, XDG_CONFIG_HOME is next, ~/.config is the fallback", (t) => {
    const dir = tempDir(t);
    assert.equal(configDir({ EDGE_CONFIG_DIR: dir }), dir);
    assert.equal(configDir({ XDG_CONFIG_HOME: "/xdg" }), path.join("/xdg", "llm-usage-tracker-edge"));
    assert.match(configDir({}), /\.config[/\\]llm-usage-tracker-edge$/);
  });

  test("the spool lives under the data dir", (t) => {
    const dir = tempDir(t);
    const { config } = loadConfig({ EDGE_CONFIG_DIR: dir, MACHINE_ID: "m", INGEST_TOKEN: TEST_TOKEN });
    assert.equal(config.spoolPath, path.join(dir, "spool", "queue.jsonl"));
  });
});
