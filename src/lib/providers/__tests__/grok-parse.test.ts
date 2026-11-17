import { describe, expect, it } from "vitest";
import { decodeBlobKey, parseGrokUsage } from "../grok-parse";

const NOW = 1_800_000_000_000;
const payload = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 2,
  value: { kind: "present", reading: {
    usage: { percentUsed: 0.12377003527446005, nextResetMs: NOW + 60_000,
      isSandTrial: false, grokPlanLabel: "Grok Bot Plan", unifiedPlanName: "Super", onDemand: null, ...over },
    readAtMs: NOW - 1_000,
  } },
});

describe("decodeBlobKey", () => {
  it("decodes an unpadded lowercase base32 key", () => {
    expect(decodeBlobKey("orsxg5a.blob")).toBe("test");
  });
  it("rejects invalid names and padding", () => {
    expect(decodeBlobKey("invalid!.blob")).toBeNull();
    expect(decodeBlobKey("me======.blob")).toBeNull();
    expect(decodeBlobKey("m.blob")).toBeNull();
    expect(decodeBlobKey("me.txt")).toBeNull();
  });
});

describe("parseGrokUsage", () => {
  it("keeps percentUsed on its existing 0-100 scale and preserves read age", () => {
    const data = parseGrokUsage(payload(), NOW)!;
    expect(data.weekly?.percentage).toBeCloseTo(0.12377003527446005);
    expect(data.weekly).toMatchObject({ tokensUsed: 0, tokenLimit: 0, resetTime: new Date(NOW + 60_000).toISOString() });
    expect(data.planName).toBe("Super");
    expect(data.planLabel).toBe("Grok Bot Plan");
    expect(data.lastUpdated).toBe(data.readAt);
    expect(data.stale).toBe(false);
  });
  it("suppresses the old window after its reset", () => {
    const data = parseGrokUsage(payload({ nextResetMs: NOW - 1 }), NOW)!;
    expect(data.windowReset).toBe(true);
    expect(data.weekly).toBeNull();
  });
  it("marks readings older than a day and clamps negative usage", () => {
    const raw = payload({ percentUsed: -2 });
    raw.value.reading.readAtMs = NOW - 24 * 60 * 60 * 1000 - 1;
    const data = parseGrokUsage(raw, NOW)!;
    expect(data.stale).toBe(true);
    expect(data.weekly?.percentage).toBe(0);
  });
  it("converts on-demand cents to dollars with and without a limit", () => {
    expect(parseGrokUsage(payload({ onDemand: { usedCents: 125, limitCents: 1000 } }), NOW)?.onDemand)
      .toEqual({ used: 1.25, limit: 10, currency: "USD" });
    expect(parseGrokUsage(payload({ onDemand: { usedCents: 99, limitCents: null } }), NOW)?.onDemand)
      .toEqual({ used: 0.99, limit: null, currency: "USD" });
  });
  it("treats absent or invalid readings as unavailable", () => {
    expect(parseGrokUsage(null, NOW)).toBeNull();
    expect(parseGrokUsage({ value: { kind: "absent" } }, NOW)).toBeNull();
    expect(parseGrokUsage({ value: { kind: "present" } }, NOW)).toBeNull();
    expect(parseGrokUsage(payload({ percentUsed: Infinity }), NOW)).toBeNull();
    const raw = payload();
    raw.value.reading.readAtMs = NaN;
    expect(parseGrokUsage(raw, NOW)).toBeNull();
  });
});
