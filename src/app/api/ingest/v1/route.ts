import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { maybeRollupDaily, processMonitorEvent, validateEventInput, type MonitorEventInput } from "@/lib/monitor-ingest";
import { normalizeMachineId, normalizeMachineLabel } from "@/lib/machine";
import type { ApiResponse, IngestResult } from "@/types";

// One batch is deliberately small: the hub writes to SQLite single-threaded, so
// a huge batch would hold the write lock long enough to stall the local hook
// path. Edges should chunk rather than send more.
export const MAX_BATCH_SIZE = 500;

function fail(status: number, code: string, message: string): NextResponse<ApiResponse<IngestResult>> {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, and the length itself is not
  // a secret worth protecting here.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * POST /api/ingest/v1 — authenticated, batched ingest from a remote machine.
 *
 * Auth v1 is a shared bearer token over Tailscale (`INGEST_TOKEN`). When the
 * token is unset the endpoint refuses everything with 503: a hub reachable on a
 * tailnet must never accept anonymous writes just because it was started
 * without configuration.
 */
export async function POST(req: NextRequest): Promise<NextResponse<ApiResponse<IngestResult>>> {
  const expected = process.env.INGEST_TOKEN?.trim();
  if (!expected) {
    return fail(503, "INGEST_DISABLED", "Ingest is not configured: set INGEST_TOKEN on the hub");
  }

  const header = req.headers.get("authorization") || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented || !tokensMatch(presented, expected)) {
    return fail(401, "UNAUTHORIZED", "Missing or invalid ingest token");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "INVALID_INPUT", "Body must be JSON");
  }

  const payload = (body ?? {}) as { machine_id?: unknown; label?: unknown; events?: unknown };

  const machineId = normalizeMachineId(payload.machine_id);
  if (!machineId) {
    return fail(400, "INVALID_INPUT", "machine_id is required (1-128 chars of [A-Za-z0-9._:-])");
  }
  const label = normalizeMachineLabel(payload.label);

  if (!Array.isArray(payload.events)) {
    return fail(400, "INVALID_INPUT", "events must be an array");
  }
  if (payload.events.length > MAX_BATCH_SIZE) {
    return fail(400, "BATCH_TOO_LARGE", `events must contain at most ${MAX_BATCH_SIZE} entries`);
  }

  const events = payload.events as Partial<MonitorEventInput>[];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event || typeof event !== "object") return fail(400, "INVALID_INPUT", `events[${i}] must be an object`);
    const invalid = validateEventInput(event);
    if (invalid) return fail(400, "INVALID_INPUT", `events[${i}]: ${invalid}`);
    // The idempotency key is what makes a retried batch safe, so it's required
    // here even though the local hook path has no use for one.
    if (typeof event.source_id !== "string" || !event.source_id) {
      return fail(400, "INVALID_INPUT", `events[${i}]: source_id is required`);
    }
  }

  try {
    const machine = { id: machineId, label };
    let accepted = 0;
    let duplicates = 0;

    for (const event of events) {
      const result = processMonitorEvent(event as MonitorEventInput, { machine });
      if (result.duplicate) duplicates++;
      else accepted++;
    }

    maybeRollupDaily();

    return NextResponse.json({ success: true, data: { machine_id: machineId, accepted, duplicates } });
  } catch (error) {
    return fail(500, "INGEST_ERROR", error instanceof Error ? error.message : "Failed to ingest batch");
  }
}
