import { describe, it, expect } from "vitest";
import { broadcastEvent, addListener, getListenerCount } from "@/lib/ws";

describe("ws broadcast", () => {
  it("delivers one pre-encoded SSE frame to every listener", () => {
    const got: Uint8Array[] = [];
    const un1 = addListener((f) => got.push(f));
    const un2 = addListener((f) => got.push(f));
    broadcastEvent({ type: "stats_updated", data: { n: 1 } });
    expect(got).toHaveLength(2);
    expect(got[0]).toBe(got[1]); // same frame object — encoded exactly once
    const text = new TextDecoder().decode(got[0]);
    expect(text).toBe(`event: message\ndata: {"type":"stats_updated","data":{"n":1}}\n\n`);
    un1(); un2();
    expect(getListenerCount()).toBe(0);
  });

  it("keeps delivering when one listener throws", () => {
    const got: Uint8Array[] = [];
    const unBad = addListener(() => { throw new Error("dead client"); });
    const unGood = addListener((f) => got.push(f));
    broadcastEvent({ type: "stats_updated", data: {} });
    expect(got).toHaveLength(1);
    unBad(); unGood();
  });
});
