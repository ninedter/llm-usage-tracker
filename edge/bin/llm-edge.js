#!/usr/bin/env node
/**
 * llm-edge — CLI for the LLM Usage Tracker edge shipper.
 *
 *   llm-edge start            run the intake + flusher in the foreground
 *   llm-edge status           queue depth and effective config (secrets redacted)
 *   llm-edge drain            ship everything queued right now
 *   llm-edge send [--dry-run] enqueue one event read from stdin (or a synthetic one)
 *   llm-edge config           print the effective config, secrets redacted
 *
 * Nothing here ever prints INGEST_TOKEN: config output goes through
 * `redactedConfig`, and every log line goes through the redacting logger.
 */
import { readFileSync } from "node:fs";
import { loadConfig, redactedConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { createEdgeAgent } from "../src/agent.js";
import { Queue } from "../src/queue.js";
import { flushOnce, buildBatchBody } from "../src/shipper.js";
import { normalizeEvent } from "../src/event.js";
import { ingestPayload } from "../src/intake.js";

const USAGE = `llm-edge <command> [options]

Commands:
  start            Run the loopback intake and the hub flusher (foreground).
  status           Show queue depth and effective config (token redacted).
  drain            Flush the spool to the hub now, then exit.
  send             Enqueue an event: JSON on stdin, or --type for a synthetic one.
  config           Print the effective config (token redacted).

Options:
  --dry-run        (send) Print the exact hub request instead of enqueueing.
  --type <name>    (send) event_type for the synthetic event. Default: tool_call.
  --json           Machine-readable output.

Environment: TRACKER_URL, INGEST_TOKEN, MACHINE_ID (required), MACHINE_LABEL,
INTAKE_HOST, INTAKE_PORT, FLUSH_INTERVAL_MS, MAX_QUEUE_EVENTS, EDGE_CONFIG_DIR.
`;

function parseArgs(argv) {
  const args = { command: argv[0] ?? "help", flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=");
    if (inline !== undefined) args.flags[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args.flags[key] = argv[++i];
    else args.flags[key] = true;
  }
  return args;
}

function out(value, json) {
  process.stdout.write(json ? JSON.stringify(value, null, 2) + "\n" : format(value) + "\n");
}

function format(value) {
  if (typeof value === "string") return value;
  return Object.entries(value)
    .map(([k, v]) => `${k.padEnd(20)} ${typeof v === "object" && v !== null ? JSON.stringify(v) : v}`)
    .join("\n");
}

/** Resolve config or exit 1 with the missing keys named — never their values. */
function requireConfig(logger) {
  const { config, errors } = loadConfig();
  if (errors.length) {
    for (const error of errors) (logger ?? console).error(`config: ${error}`);
    process.exit(1);
  }
  return config;
}

function intakeUrl(config, path) {
  return `http://${config.intakeHost}:${config.intakePort}${path}`;
}

async function askDaemon(config, path, method = "GET") {
  try {
    const res = await fetch(intakeUrl(config, path), { method, signal: AbortSignal.timeout(5_000) });
    return await res.json();
  } catch {
    return null;
  }
}

function openQueue(config) {
  return new Queue({ path: config.spoolPath, maxEvents: config.maxQueueEvents }).load();
}

async function cmdStart() {
  const config = requireConfig();
  const logger = createLogger({ secrets: [config.token], level: process.env.LOG_LEVEL || "info" });
  const agent = createEdgeAgent({ config, log: logger });
  try {
    await agent.start();
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      logger.error(`intake port ${config.intakePort} is already in use — another edge is probably running`);
      process.exit(1);
    }
    throw error;
  }
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`received ${signal}, shutting down`);
      agent.stop().then(() => process.exit(0), () => process.exit(1));
    });
  }
}

async function cmdStatus(flags) {
  const { config, errors } = loadConfig();
  const live = await askDaemon(config, "/status");
  const queue = live ? null : openQueue(config);
  const data = {
    running: Boolean(live),
    machine_id: config.machineId || "(unset)",
    hub: config.ingestUrl,
    intake: intakeUrl(config, ""),
    ...(live?.data ?? { ...queue.stats(), config: redactedConfig(config) }),
    config_errors: errors,
  };
  out(data, Boolean(flags.json));
  return errors.length ? 1 : 0;
}

async function cmdDrain(flags) {
  const config = requireConfig();
  const live = await askDaemon(config, "/drain", "POST");
  if (live) {
    out({ via: "running edge", ...live.data }, Boolean(flags.json));
    return 0;
  }
  // No daemon: drain the spool in-process, which is also how a cron-style
  // "ship whatever is queued" would work.
  const logger = createLogger({ secrets: [config.token], level: process.env.LOG_LEVEL || "info" });
  const queue = openQueue(config);
  const summary = await flushOnce(queue, config, { log: logger });
  out({ via: "one-shot", ...summary, queued: queue.size() }, Boolean(flags.json));
  return summary.stopped ? 1 : 0;
}

async function cmdSend(flags) {
  const config = requireConfig();
  let raw;
  const stdinText = process.stdin.isTTY ? "" : readFileSync(0, "utf8").trim();
  if (stdinText) {
    raw = JSON.parse(stdinText);
  } else {
    const now = Date.now();
    raw = {
      agent_id: `edge-cli-${now}`,
      session_id: `edge-cli-${now}`,
      event_type: typeof flags.type === "string" ? flags.type : "tool_call",
      tool_name: "Bash",
      summary: "llm-edge send: synthetic event",
      content: "",
      files_affected: [],
      agent_project: "llm-usage-tracker",
      agent_entrypoint: "cli",
      agent_cwd: process.cwd(),
      provider: "anthropic",
      timestamp: now,
    };
  }

  if (flags["dry-run"]) {
    const event = normalizeEvent(raw);
    out({
      url: config.ingestUrl,
      // The real request carries `authorization: Bearer <token>`; printing the
      // literal header here would defeat the point of the exercise.
      headers: { "content-type": "application/json", authorization: "Bearer [REDACTED]" },
      body: buildBatchBody(config, [event]),
    }, true);
    return 0;
  }

  const res = await fetch(intakeUrl(config, "/v1/events"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(raw),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);

  if (res) {
    out({ via: "running edge", ...(await res.json()).data }, Boolean(flags.json));
    return 0;
  }
  const queue = openQueue(config);
  const result = ingestPayload(queue, raw);
  out({ via: "spool (edge not running)", ...result, queued: queue.size() }, Boolean(flags.json));
  return 0;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "start": return (await cmdStart(), 0);
    case "status": return await cmdStatus(flags);
    case "drain": return await cmdDrain(flags);
    case "send": return await cmdSend(flags);
    case "config": {
      const { config, errors } = loadConfig();
      out({ ...redactedConfig(config), config_errors: errors }, Boolean(flags.json));
      return errors.length ? 1 : 0;
    }
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => {
    // `start` never resolves into an exit: its intake server keeps the loop alive.
    if (code) process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`llm-edge: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
);
