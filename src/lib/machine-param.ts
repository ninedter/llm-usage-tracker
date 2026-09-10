import { NextResponse } from "next/server";
import { normalizeMachineId } from "@/lib/machine";
import type { ApiResponse } from "@/types";

/**
 * Read a validated `?machine=` filter off a request URL.
 *
 * Absent, "" or "all" mean *no* machine scope — the All option and clients that
 * predate the hub behave identically, exactly like `?provider=`.
 *
 * Where this differs from readProvider: a provider is one of two known literals,
 * so an unrecognised value can safely mean "unscoped". A machine id is
 * free-form, so silently ignoring a malformed one would show every machine's
 * rows under a single machine's heading. Present-but-invalid returns `null`
 * instead, and routes turn that into a 400 via {@link invalidMachineResponse}.
 * The charset is the one ingest already enforces (see normalizeMachineId), so a
 * value the hub accepted on write is always accepted on read.
 */
export function readMachine(url: URL): string | undefined | null {
  const raw = url.searchParams.get("machine");
  if (raw === null || raw === "" || raw === "all") return undefined;
  return normalizeMachineId(raw);
}

/** 400 for a malformed `?machine=`, in the same envelope as every other route error. */
export function invalidMachineResponse<T>(): NextResponse<ApiResponse<T>> {
  return NextResponse.json(
    {
      success: false,
      error: {
        code: "INVALID_MACHINE",
        message: "machine must be 1-128 characters of [A-Za-z0-9._:-], or 'all'",
      },
    },
    { status: 400 }
  );
}
