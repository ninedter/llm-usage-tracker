import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Liveness only: proves the HTTP server is up. Deliberately touches nothing —
// no DB, no provider APIs — so the Electron docker-probe and the container
// HEALTHCHECK measure *this server*, not Anthropic/OpenAI latency.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ success: true, data: { status: "ok" } });
}
