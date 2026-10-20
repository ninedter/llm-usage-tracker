import { describe, it, expect } from "vitest";
import { dataUnlessUnconfigured } from "../stale-data";

describe("dataUnlessUnconfigured", () => {
  const data = { percentage: 42 };

  it("passes data through when there's no error", () => {
    expect(dataUnlessUnconfigured(data, undefined)).toBe(data);
  });

  it("drops stale data once credentials are missing", () => {
    expect(dataUnlessUnconfigured(data, { code: "MISSING_CREDENTIALS" })).toBeUndefined();
  });

  it.each(["AUTH_EXPIRED", "FETCH_ERROR", undefined])(
    "keeps the last data through a %s error",
    (code) => {
      expect(dataUnlessUnconfigured(data, { code })).toBe(data);
    }
  );
});
