import { describe, it, expect } from "vitest";
import { usageRetryDelay } from "@/lib/usage/retry-delay";
import { REFRESH_INTERVALS } from "@/lib/constants";

// random() = 0.5 makes SWR's jitter factor exactly 1, so delays are deterministic
const mid = () => 0.5;

describe("usageRetryDelay", () => {
  it("MISSING_CREDENTIALS keeps polling at the usage interval", () => {
    for (const n of [1, 5, 50]) {
      expect(usageRetryDelay("MISSING_CREDENTIALS", n, 5_000, mid)).toBe(REFRESH_INTERVALS.usage);
    }
  });

  it("other errors back off exponentially like SWR's default", () => {
    expect(usageRetryDelay("FETCH_ERROR", 1, 5_000, mid)).toBe(10_000);
    expect(usageRetryDelay("AUTH_EXPIRED", 2, 5_000, mid)).toBe(20_000);
    expect(usageRetryDelay(undefined, 3, 5_000, mid)).toBe(40_000);
  });

  it("caps the backoff at the usage polling interval", () => {
    expect(usageRetryDelay("FETCH_ERROR", 4, 5_000, mid)).toBe(REFRESH_INTERVALS.usage);
    expect(usageRetryDelay("FETCH_ERROR", 8, 5_000, () => 0.99)).toBe(REFRESH_INTERVALS.usage);
    expect(usageRetryDelay("AUTH_EXPIRED", 30, 10_000, mid)).toBe(REFRESH_INTERVALS.usage);
  });

  it("defaults to SWR's 5 s retry interval", () => {
    expect(usageRetryDelay("FETCH_ERROR", 1, undefined, mid)).toBe(10_000);
  });
});
