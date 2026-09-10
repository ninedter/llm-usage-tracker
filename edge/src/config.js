/**
 * Edge configuration: environment first, optional config file second.
 *
 * The same code runs on macOS and Linux, so every path is built from
 * `os.homedir()` + `path.join` — no `/Users/...`, no Keychain, no registry.
 * Secrets (`INGEST_TOKEN`) come from the environment or a config file the user
 * owns; they are never written back to disk by the edge and never logged.
 */
import { homedir } from "node:os";
import path from "node:path";
import fs from "node:fs";

/** Hub default: HTTP over Tailscale (see README "Multi-machine hub"). */
export const DEFAULT_TRACKER_URL = "http://henrys-mac-mini:3789";
/** Loopback intake port the Claude Code hooks post into. */
export const DEFAULT_INTAKE_PORT = 3799;
/** Hub caps a batch at 500 events (`MAX_BATCH_SIZE` in the ingest route). */
export const HUB_MAX_BATCH_SIZE = 500;

const CONFIG_DIR_NAME = "llm-usage-tracker-edge";
/** Keys that must never be echoed, logged or returned by `status`. */
export const SECRET_KEYS = ["INGEST_TOKEN"];

/**
 * Where config and spool live. `EDGE_CONFIG_DIR` overrides everything (tests,
 * multi-instance); otherwise XDG on Linux and the same `~/.config` layout on
 * macOS — one path to document for both v1 platforms.
 */
export function configDir(env = process.env) {
  if (env.EDGE_CONFIG_DIR) return path.resolve(env.EDGE_CONFIG_DIR);
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".config");
  return path.join(base, CONFIG_DIR_NAME);
}

/** Spool + runtime state. Defaults to the config dir so there is one dir to back up or delete. */
export function dataDir(env = process.env) {
  if (env.EDGE_DATA_DIR) return path.resolve(env.EDGE_DATA_DIR);
  return configDir(env);
}

/**
 * Parse a dotenv-ish file: `KEY=value`, `#` comments, optional surrounding
 * quotes. Deliberately tiny — a dependency here would have to be audited on
 * every machine that ships usage data.
 */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Read `config.json` and/or `.env` from the config dir. Missing files are not an error. */
export function readConfigFiles(dir) {
  const values = {};
  const jsonPath = path.join(dir, "config.json");
  if (fs.existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (v !== null && v !== undefined && typeof v !== "object") values[k] = String(v);
        }
      }
    } catch {
      // A malformed config file must not stop the shipper: env may already
      // carry everything it needs, and the hooks keep exiting 0 either way.
    }
  }
  const envPath = path.join(dir, ".env");
  if (fs.existsSync(envPath)) {
    try {
      Object.assign(values, parseEnvFile(fs.readFileSync(envPath, "utf8")));
    } catch { /* same reasoning as above */ }
  }
  return values;
}

/** Same charset the hub enforces in `normalizeMachineId` — reject early, locally. */
export function isValidMachineId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(id);
}

function intOr(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the effective config. Returns `{ config, errors }` — the caller
 * decides whether to exit (`start`) or report (`status`), and `errors` never
 * contains a value, only the name of the offending key.
 */
export function loadConfig(env = process.env) {
  const dir = configDir(env);
  const fileValues = readConfigFiles(dir);
  // Environment wins: a launchd/systemd unit or a one-off shell export should
  // always beat a stale file.
  const get = (key) => {
    const fromEnv = env[key];
    if (fromEnv !== undefined && String(fromEnv).trim() !== "") return String(fromEnv).trim();
    const fromFile = fileValues[key];
    if (fromFile !== undefined && String(fromFile).trim() !== "") return String(fromFile).trim();
    return "";
  };

  const trackerUrl = get("TRACKER_URL") || DEFAULT_TRACKER_URL;
  const machineId = get("MACHINE_ID");
  const token = get("INGEST_TOKEN");
  const errors = [];

  if (!machineId) errors.push("MACHINE_ID is required (e.g. grok-bot-box, henrymacbook-pro)");
  else if (!isValidMachineId(machineId)) errors.push("MACHINE_ID must be 1-128 chars of [A-Za-z0-9._:-]");
  if (!token) errors.push("INGEST_TOKEN is required (shared bearer token from the hub)");

  let parsedUrl = null;
  try {
    parsedUrl = new URL(trackerUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("scheme");
  } catch {
    errors.push("TRACKER_URL must be an http(s) URL");
  }

  const batchSize = Math.min(intOr(get("MAX_BATCH_SIZE"), HUB_MAX_BATCH_SIZE), HUB_MAX_BATCH_SIZE);

  const config = {
    trackerUrl: parsedUrl ? parsedUrl.origin + parsedUrl.pathname.replace(/\/$/, "") : trackerUrl,
    ingestPath: "/api/ingest/v1",
    machineId,
    machineLabel: get("MACHINE_LABEL") || null,
    token,
    intakeHost: get("INTAKE_HOST") || "127.0.0.1",
    intakePort: intOr(get("INTAKE_PORT"), DEFAULT_INTAKE_PORT),
    flushIntervalMs: intOr(get("FLUSH_INTERVAL_MS"), 5_000),
    batchSize,
    maxQueueEvents: intOr(get("MAX_QUEUE_EVENTS"), 100_000),
    backoffBaseMs: intOr(get("BACKOFF_BASE_MS"), 2_000),
    backoffMaxMs: intOr(get("BACKOFF_MAX_MS"), 300_000),
    requestTimeoutMs: intOr(get("REQUEST_TIMEOUT_MS"), 15_000),
    configDir: dir,
    dataDir: dataDir(env),
  };
  config.ingestUrl = config.trackerUrl + config.ingestPath;
  config.spoolPath = path.join(config.dataDir, "spool", "queue.jsonl");

  return { config, errors };
}

/** Config minus secrets, safe to print or serve from `/status`. */
export function redactedConfig(config) {
  const { token, ...rest } = config;
  return { ...rest, token: token ? "***set***" : "***missing***" };
}
