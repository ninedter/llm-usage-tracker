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

  it("a late rejection does not evict a newer entry for the same key", async () => {
    vi.useFakeTimers();
    const cache = ttlCache<number>(1_000);
    let rejectOld: (e: Error) => void;
    const oldPromise = cache.get("k", () => new Promise<number>((_, rej) => { rejectOld = rej; }));
    oldPromise.catch(() => {}); // observe, don't unhandled-reject
    vi.advanceTimersByTime(1_500); // old entry now past TTL
    const fresh = vi.fn(async () => 42);
    const newPromise = cache.get("k", fresh); // installs successor
    rejectOld!(new Error("late failure"));
    await Promise.resolve(); // let the catch run
    const again = cache.get("k", vi.fn(async () => 99)); // must hit the successor, not recompute
    await expect(newPromise).resolves.toBe(42);
    await expect(again).resolves.toBe(42);
    expect(fresh).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
