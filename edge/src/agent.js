/**
 * The always-on edge: loopback intake in front of a durable spool, with a
 * single flush chain behind it.
 *
 * One timer chain rather than a fixed interval — a periodic flush that
 * overlapped a slow request would double-send batches, and backoff needs to be
 * able to push the next attempt minutes out while intake keeps accepting
 * events at full speed.
 */
import { Queue } from "./queue.js";
import { createIntakeServer } from "./intake.js";
import { flushOnce, nextBackoffMs } from "./shipper.js";

/** How soon a freshly enqueued event triggers a flush, when not backing off. */
const COALESCE_MS = 250;

export function createEdgeAgent({ config, log, fetch: fetchImpl }) {
  const queue = new Queue({
    path: config.spoolPath,
    maxEvents: config.maxQueueEvents,
    onDrop: ({ reason, count }) => log.warn("dropped spooled events", { reason, count }),
  }).load();

  let timer = null;
  let flushing = false;
  let failures = 0;
  let stopping = false;
  let lastSummary = null;

  function schedule(delayMs) {
    if (stopping) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
    // A pending flush must never hold the process open on its own; the intake
    // server is what keeps `start` alive.
    timer.unref?.();
  }

  async function flush() {
    if (flushing || stopping) return lastSummary;
    if (queue.size() === 0) {
      schedule(config.flushIntervalMs);
      return lastSummary;
    }
    flushing = true;
    try {
      lastSummary = await flushOnce(queue, config, { fetch: fetchImpl, log });
      if (lastSummary.stopped) {
        failures++;
        const delay = nextBackoffMs(failures, config);
        log.debug("backing off", { attempt: failures, delay_ms: delay, queued: queue.size() });
        schedule(delay);
      } else {
        if (failures > 0) log.info("hub reachable again", { queued: queue.size() });
        failures = 0;
        schedule(config.flushIntervalMs);
      }
      return lastSummary;
    } finally {
      flushing = false;
    }
  }

  /** Called by intake after an event lands: flush soon, unless we're backing off. */
  function requestFlush() {
    if (flushing || stopping || failures > 0) return;
    schedule(COALESCE_MS);
  }

  const server = createIntakeServer({
    queue,
    config,
    log,
    requestFlush,
    // `POST /drain` bypasses backoff on purpose: it exists so a human can say
    // "try right now, I just fixed the network".
    drain: async () => {
      failures = 0;
      return (await flush()) ?? { batches: 0, accepted: 0, duplicates: 0, dropped: 0, stopped: null };
    },
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.intakePort, config.intakeHost, () => {
        server.removeListener("error", reject);
        server.on("error", (error) => log.error("intake server error", { error: String(error?.message ?? error) }));
        log.info("edge started", {
          machine_id: config.machineId,
          intake: `http://${config.intakeHost}:${config.intakePort}`,
          hub: config.ingestUrl,
          queued: queue.size(),
          spool: config.spoolPath,
        });
        schedule(COALESCE_MS);
        resolve();
      });
    });
  }

  async function stop() {
    stopping = true;
    if (timer) clearTimeout(timer);
    await new Promise((resolve) => server.close(resolve));
    // One last attempt so a clean restart doesn't leave a backlog sitting for
    // the flush interval — but stopping must not hang on an unreachable hub.
    stopping = false;
    try {
      await Promise.race([flush(), new Promise((r) => setTimeout(r, config.requestTimeoutMs))]);
    } finally {
      stopping = true;
      if (timer) clearTimeout(timer);
    }
    log.info("edge stopped", { queued: queue.size() });
  }

  return { queue, server, start, stop, flush, config };
}
