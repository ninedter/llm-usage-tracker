import { describe, it, expect, vi } from "vitest";
import { ttlCache } from "@/lib/ttl-cache";

describe("ttlCache", () => {
  it("computes once within TTL and shares in-flight promises", async () => {
    const cache = ttlCache<number>(10_000);
    const compute = vi.fn(async () => 42);
    const [a, b] = await Promise.all([cache.get("k", compute), cache.get("k", compute)]);
    expect(a).toBe(42); expect(b).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
    await cache.get("k", compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes after TTL expiry", async () => {
    vi.useFakeTimers();
    const cache = ttlCache<number>(1_000);
    const compute = vi.fn(async () => 1);
    await cache.get("k", compute);
    vi.advanceTimersByTime(1_500);
    await cache.get("k", compute);
    expect(compute).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not cache rejections", async () => {
    const cache = ttlCache<number>(10_000);
    let n = 0;
    const compute = async () => { n++; if (n === 1) throw new Error("boom"); return 7; };
    await expect(cache.get("k", compute)).rejects.toThrow("boom");
    await expect(cache.get("k", compute)).resolves.toBe(7);
  });

  it("invalidate forces recompute", async () => {
    const cache = ttlCache<number>(10_000);
    const compute = vi.fn(async () => 5);
    await cache.get("k", compute);
    cache.invalidate("k");
    await cache.get("k", compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
