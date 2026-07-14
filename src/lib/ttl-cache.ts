// Tiny promise-aware TTL memo. One in-flight compute per key; failures are
// never cached so a transient upstream error doesn't stick for the TTL.
type Entry<T> = { at: number; promise: Promise<T> };

export function ttlCache<T>(ttlMs: number) {
  const entries = new Map<string, Entry<T>>();
  return {
    get(key: string, compute: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
      const promise = compute().catch((err) => {
        entries.delete(key); // don't cache failures
        throw err;
      });
      entries.set(key, { at: Date.now(), promise });
      return promise;
    },
    invalidate(key: string): void {
      entries.delete(key);
    },
  };
}
