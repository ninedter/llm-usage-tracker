import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact, createLogger, REDACTED } from "../src/log.js";
import { redactedConfig } from "../src/config.js";
import { buildHeaders } from "../src/shipper.js";
import { testConfig, collectingSink, TEST_TOKEN } from "./helpers.js";

describe("redact", () => {
  test("removes the literal token wherever it appears", () => {
    const line = `POST failed with Authorization: Bearer ${TEST_TOKEN}`;
    const out = redact(line, [TEST_TOKEN]);
    assert.equal(out.includes(TEST_TOKEN), false);
    assert.match(out, new RegExp(REDACTED.replace(/[[\]]/g, "\\$&")));
  });

  test("removes every occurrence, not just the first", () => {
    const out = redact(`${TEST_TOKEN} and again ${TEST_TOKEN}`, [TEST_TOKEN]);
    assert.equal(out.includes(TEST_TOKEN), false);
  });

  test("redacts a bearer header even when the token isn't in the secrets list", () => {
    const out = redact("authorization: Bearer some-token-we-never-configured", []);
    assert.equal(out.includes("some-token-we-never-configured"), false);
  });

  test("redacts token-shaped fields in serialized objects", () => {
    const out = redact({ INGEST_TOKEN: "abc123def456", url: "http://hub:3789" }, []);
    assert.equal(out.includes("abc123def456"), false);
    assert.match(out, /hub:3789/, "non-secret context survives");
  });

  test("leaves short strings alone so logs stay readable", () => {
    assert.equal(redact("machine grok-bot-box is up", ["up"]), "machine grok-bot-box is up");
  });

  test("handles errors and non-strings", () => {
    assert.match(redact(new Error(`bad token ${TEST_TOKEN}`), [TEST_TOKEN]), /Error: bad token \[REDACTED\]/);
    assert.equal(redact(42, []), "42");
  });
});

describe("createLogger", () => {
  test("never writes a configured secret, whatever is logged", () => {
    const sink = collectingSink();
    const config = testConfig();
    const log = createLogger({ secrets: [config.token], sink, level: "debug" });

    log.info("starting", redactedConfig(config));
    log.error("hub call failed", { headers: buildHeaders(config) });
    log.warn(`raw leak attempt: ${config.token}`);
    log.debug("nested", { deep: { token: config.token } });

    const text = sink.text();
    assert.equal(text.includes(TEST_TOKEN), false, "token must never reach a log sink");
    assert.match(text, /starting/);
    assert.match(text, /grok-bot-box/, "useful context is still logged");
  });

  test("respects the level threshold", () => {
    const sink = collectingSink();
    createLogger({ sink, level: "warn" }).info("quiet");
    assert.deepEqual(sink.lines, []);
  });

  test("lines carry a timestamp and a level", () => {
    const sink = collectingSink();
    createLogger({ sink, clock: () => new Date(0) }).info("hello");
    assert.match(sink.lines[0], /^1970-01-01T00:00:00\.000Z INFO {2}hello$/);
  });
});

describe("redactedConfig", () => {
  test("reports whether a token is set without revealing it", () => {
    assert.equal(redactedConfig(testConfig()).token, "***set***");
    assert.equal(redactedConfig(testConfig({ token: "" })).token, "***missing***");
    assert.equal(JSON.stringify(redactedConfig(testConfig())).includes(TEST_TOKEN), false);
  });
});
