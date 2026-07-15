// Tiny promise-aware TTL memo. One in-flight compute per key; failures are
// never cached so a transient upstream error doesn't stick for the TTL.
type Entry<T> = { at: number; promise: Promise<T> };

export function ttlCache<T>(ttlMs: number) {
  const entries = new Map<string, Entry<T>>();
  return {
    get(key: string, compute: () => Promise<T>): Promise<T> {
      const hit = entries.get(key);
      if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
      const entry: Entry<T> = { at: Date.now(), promise: undefined as unknown as Promise<T> };
      entry.promise = compute().catch((err) => {
        // don't cache failures — but only evict this entry's own slot; if a
        // newer compute already replaced it in the map, a late rejection
        // here must not evict that successor.
        if (entries.get(key) === entry) entries.delete(key);
        throw err;
      });
      entries.set(key, entry);
      return entry.promise;
    },
    invalidate(key: string): void {
      entries.delete(key);
    },
  };
}
