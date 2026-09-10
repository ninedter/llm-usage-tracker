/**
 * Loopback intake.
 *
 * Claude Code hooks must stay fast and always exit 0, so they post here — a
 * server on 127.0.0.1 that appends to the spool and answers 202 in about a
 * millisecond — instead of talking to the hub over the tailnet themselves.
 * Whether the hub is up, down or three timezones away stops being the hook's
 * problem.
 *
 * `POST /api/monitor/events` is deliberately the hub's own local path: an
 * existing hook only needs `MONITOR_URL=http://127.0.0.1:3799` to ship through
 * the edge, with no change to `hooks/agent-monitor-hook.py`.
 */
import http from "node:http";
import { normalizeEvent, eventsFromPayload, InvalidEventError } from "./event.js";
import { redactedConfig } from "./config.js";

/** A hook event is a few KB; anything past this is a bug or an abuse. */
const MAX_BODY_BYTES = 1_000_000;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Enqueue a payload holding one event or a batch.
 * @returns {{accepted: number, duplicates: number, rejected: {index: number, reason: string}[]}}
 */
export function ingestPayload(queue, payload, opts = {}) {
  const result = { accepted: 0, duplicates: 0, rejected: [] };
  const raws = eventsFromPayload(payload);
  raws.forEach((raw, index) => {
    try {
      const event = normalizeEvent(raw, opts);
      const { duplicate } = queue.enqueue(event);
      if (duplicate) result.duplicates++;
      else result.accepted++;
    } catch (error) {
      if (error instanceof InvalidEventError) result.rejected.push({ index, reason: error.message });
      else throw error;
    }
  });
  return result;
}

/**
 * @param {{ queue: import("./queue.js").Queue, config: object, log: object, requestFlush?: () => void, drain?: () => Promise<object> }} deps
 */
export function createIntakeServer(deps) {
  const { queue, config, log } = deps;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /health" || route === "GET /api/health") {
        return send(res, 200, { success: true, data: { ok: true, machine_id: config.machineId, queued: queue.size() } });
      }

      if (route === "GET /status") {
        return send(res, 200, {
          success: true,
          // redactedConfig, never the raw config: /status is the one endpoint
          // people paste into a chat window when something is wrong.
          data: { ...queue.stats(), machine_id: config.machineId, config: redactedConfig(config) },
        });
      }

      if (route === "POST /drain") {
        const summary = deps.drain ? await deps.drain() : { stopped: "no_flusher" };
        return send(res, 200, { success: true, data: summary });
      }

      if (route === "POST /v1/events" || route === "POST /api/monitor/events") {
        const text = await readBody(req);
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          return send(res, 400, { success: false, error: { code: "INVALID_INPUT", message: "body must be JSON" } });
        }
        const result = ingestPayload(queue, payload);
        if (result.rejected.length) {
          log.warn("rejected malformed event(s) from a hook", { count: result.rejected.length, reasons: result.rejected.map((r) => r.reason) });
        }
        if (result.accepted) deps.requestFlush?.();
        // 202: accepted into the spool. The hook is done; delivery to the hub
        // is the edge's job from here.
        return send(res, 202, { success: true, data: result });
      }

      return send(res, 404, { success: false, error: { code: "NOT_FOUND", message: `no route for ${route}` } });
    } catch (error) {
      log.error("intake request failed", { route, error: String(error?.message ?? error) });
      if (!res.headersSent) send(res, 500, { success: false, error: { code: "INTAKE_ERROR", message: "request failed" } });
    }
  });

  return server;
}
