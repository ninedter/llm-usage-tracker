/**
 * Logging with mandatory redaction.
 *
 * The edge holds one secret — the hub's `INGEST_TOKEN` — and it appears in a
 * header on every request, so any naive dump of a request, a config object or
 * an error would leak it into a log file or a systemd journal. Every line goes
 * through `redact()` before it reaches stdout, and the token value is matched
 * literally rather than by field name so it stays hidden even when it turns up
 * somewhere unexpected (an error message, a stringified header bag).
 */

export const REDACTED = "[REDACTED]";

/** Patterns that hide a secret we can recognise by shape, not by value. */
const SHAPE_PATTERNS = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  [/((?:"|')?(?:ingest_?token|token|authorization|api_?key|secret)(?:"|')?\s*[:=]\s*)(?:"|')?[^\s"',}]+(?:"|')?/gi, `$1${REDACTED}`],
];

/**
 * Replace every occurrence of the given secrets, then anything that merely
 * looks like a credential. Short secrets (< 8 chars) are skipped for the
 * literal pass: a 3-character "token" would blank out unrelated text and make
 * the logs useless, and no real hub token is that short.
 */
export function redact(value, secrets = []) {
  let text = typeof value === "string" ? value : safeStringify(value);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    text = text.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of SHAPE_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

function safeStringify(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * @param {{ secrets?: string[], level?: keyof LEVELS, sink?: (line: string) => void, clock?: () => Date }} opts
 */
export function createLogger(opts = {}) {
  const secrets = (opts.secrets ?? []).filter(Boolean);
  const threshold = LEVELS[opts.level ?? "info"] ?? LEVELS.info;
  const sink = opts.sink ?? ((line) => process.stdout.write(line + "\n"));
  const clock = opts.clock ?? (() => new Date());

  function emit(level, message, fields) {
    if (LEVELS[level] < threshold) return;
    const parts = [clock().toISOString(), level.toUpperCase().padEnd(5), redact(message, secrets)];
    if (fields !== undefined) parts.push(redact(fields, secrets));
    sink(parts.join(" "));
  }

  return {
    secrets,
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
