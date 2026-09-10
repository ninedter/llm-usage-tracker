import { NextRequest, NextResponse } from "next/server";
import { listRecentEvents } from "@/lib/db";
import { maybeRollupDaily, processMonitorEvent, validateEventInput } from "@/lib/monitor-ingest";
import { readProvider } from "@/lib/provider-param";
import { invalidMachineResponse, readMachine } from "@/lib/machine-param";
import type { ApiResponse, AgentEvent } from "@/types";

// GET /api/monitor/events — Newest events across all agents (optionally one
// provider), newest first. Hydrates the Activity feed on load/provider switch.
export async function GET(req: NextRequest): Promise<NextResponse<ApiResponse<AgentEvent[]>>> {
  try {
    const url = new URL(req.url);
    const provider = readProvider(url);
    const machine = readMachine(url);
    if (machine === null) return invalidMachineResponse();
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 500);

    const events = listRecentEvents(limit, provider, machine);
    return NextResponse.json({ success: true, data: events });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "FETCH_ERROR", message: error instanceof Error ? error.message : "Failed to fetch events" } },
      { status: 500 }
    );
  }
}

// POST /api/monitor/events — Record a new event and handle lifecycle transitions.
// Local/dev path: unauthenticated, and everything it writes is stamped with the
// `local` machine id. Remote machines use the authenticated POST /api/ingest/v1
// instead; both share the lifecycle logic in @/lib/monitor-ingest.
export async function POST(req: NextRequest): Promise<NextResponse<ApiResponse<AgentEvent>>> {
  try {
    const body = await req.json();

    const invalid = validateEventInput(body);
    if (invalid) {
      return NextResponse.json(
        { success: false, error: { code: "INVALID_INPUT", message: "agent_id and event_type are required" } },
        { status: 400 }
      );
    }

    // source_id is deliberately dropped: on this path it would let any local
    // caller drive the hub's idempotency index. Local hooks don't send one, so
    // the insert is unconditional and `event` is always present.
    const { event } = processMonitorEvent({ ...body, source_id: null });
    maybeRollupDaily();

    return NextResponse.json({ success: true, data: event! }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: { code: "CREATE_ERROR", message: error instanceof Error ? error.message : "Failed to create event" } },
      { status: 500 }
    );
  }
}
