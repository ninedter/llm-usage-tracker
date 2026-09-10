/**
 * Flusher: spool -> `POST ${TRACKER_URL}/api/ingest/v1`.
 *
 * The hub's failure modes are all distinct actions here:
 *   200      ship succeeded, ack the batch (duplicates count as shipped)
 *   400      the batch is unshippable as-is — drop it, or it blocks the queue forever
 *   401/403  wrong/missing token — keep everything, back off long, say so once
 *   503      hub has no INGEST_TOKEN configured yet — keep everything, retry
 *   5xx/net  transient — keep everything, exponential backoff
 */
export const OK = "ok";
export const DROP = "drop";
export const AUTH = "auth";
export const RETRY = "retry";

/** Build the exact body the hub contract specifies. */
export function buildBatchBody(config, events) {
  const body = { machine_id: config.machineId, events };
  if (config.machineLabel) body.label = config.machineLabel;
  return body;
}

/** Auth header for the hub. Kept in one place so no other module handles the token. */
export function buildHeaders(config) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${config.token}`,
  };
}

function classify(status) {
  if (status >= 200 && status < 300) return OK;
  if (status === 401 || status === 403) return AUTH;
  if (status === 400) return DROP;
  return RETRY;
}

/**
 * POST one batch. Never throws: a network failure is just a retryable result.
 * @returns {Promise<{kind: string, status: number, accepted: number, duplicates: number, message: string|null}>}
 */
export async function postBatch(config, events, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeoutMs = config.requestTimeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(config.ingestUrl, {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify(buildBatchBody(config, events)),
      signal: controller.signal,
    });
    const kind = classify(res.status);
    let payload = null;
    try {
      payload = await res.json();
    } catch { /* the hub always answers JSON, but a proxy in between might not */ }
    return {
      kind,
      status: res.status,
      accepted: payload?.data?.accepted ?? 0,
      duplicates: payload?.data?.duplicates ?? 0,
      // Error *messages* from the hub are safe to log; the token never appears
      // in one, and the logger redacts anyway.
      message: payload?.error?.message ?? null,
    };
  } catch (error) {
    return {
      kind: RETRY,
      status: 0,
      accepted: 0,
      duplicates: 0,
      message: error?.name === "AbortError" ? `request timed out after ${timeoutMs}ms` : String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Drain the queue in hub-sized chunks until it is empty or the hub pushes back.
 * Each batch is acked before the next is sent, so an interrupted flush never
 * re-sends what already landed.
 */
export async function flushOnce(queue, config, deps = {}) {
  const log = deps.log ?? { info() {}, warn() {}, error() {}, debug() {} };
  const summary = { batches: 0, accepted: 0, duplicates: 0, dropped: 0, stopped: null, status: 0 };

  while (queue.size() > 0) {
    // peek() is the chunker: never more than the hub's cap in one request.
    const batch = queue.peek(config.batchSize);
    const result = await postBatch(config, batch, deps);
    summary.batches++;
    summary.status = result.status;

    if (result.kind === OK) {
      queue.ack(batch.map((e) => e.source_id));
      summary.accepted += result.accepted;
      summary.duplicates += result.duplicates;
      log.debug("batch shipped", { count: batch.length, accepted: result.accepted, duplicates: result.duplicates });
      continue;
    }

    if (result.kind === DROP) {
      // Rejected batches stay rejected on every retry; keeping them would wedge
      // every later event behind them. Log the count and the hub's reason only.
      queue.ack(batch.map((e) => e.source_id));
      summary.dropped += batch.length;
      log.error("hub rejected a batch as invalid — dropped it", { count: batch.length, status: result.status, reason: result.message });
      continue;
    }

    summary.stopped = result.kind;
    if (result.kind === AUTH) {
      log.error("hub rejected the ingest token — check INGEST_TOKEN on this machine and the hub", { status: result.status });
    } else {
      log.warn("hub unreachable or erroring — keeping events queued", { status: result.status, reason: result.message, queued: queue.size() });
    }
    break;
  }

  return summary;
}

/**
 * Exponential backoff with jitter. `attempt` is 1-based; jitter spreads the
 * retries of several machines that all lost the tailnet at the same moment.
 */
export function nextBackoffMs(attempt, config, random = Math.random) {
  const base = config.backoffBaseMs ?? 2_000;
  const max = config.backoffMaxMs ?? 300_000;
  const raw = Math.min(base * 2 ** Math.max(0, attempt - 1), max);
  const jitter = 0.8 + random() * 0.4;
  return Math.min(Math.round(raw * jitter), max);
}
