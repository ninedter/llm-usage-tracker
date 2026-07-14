import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/live/route";

describe("GET /api/live", () => {
  it("returns ok without touching providers or DB", async () => {
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ success: true, data: { status: "ok" } });
  });
});
