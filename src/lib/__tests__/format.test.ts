import { describe, it, expect } from "vitest";
import { formatCredits, formatMoney } from "@/lib/format";

describe("formatMoney", () => {
  it("formats a known currency with two decimals", () => {
    expect(formatMoney(12.3, "USD")).toContain("12.30");
  });

  it("formats a non-USD currency without throwing", () => {
    expect(() => formatMoney(2.77, "CAD")).not.toThrow();
    expect(formatMoney(2.77, "CAD")).toContain("2.77");
  });

  it("falls back to '<code> <amount>' for an invalid currency code", () => {
    expect(formatMoney(1, "???")).toBe("??? 1.00");
  });
});

describe("formatCredits", () => {
  it("renders whole numbers as integers", () => {
    expect(formatCredits(240)).toBe("240");
  });

  it("keeps up to two decimals", () => {
    expect(formatCredits(9.99)).toBe("9.99");
  });

  it("adds thousands separators", () => {
    expect(formatCredits(1234.5)).toBe("1,234.5");
  });
});
