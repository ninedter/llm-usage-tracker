import type { AgentEvent } from "@/types";

export const ACTIVITY_FEED_CAP = 100;

/**
 * Merge DB-hydrated events into the live Activity feed.
 *
 * The feed has two sources racing each other: the hydration fetch (newest N
 * rows from the DB) and SSE events that may arrive while that fetch is in
 * flight. The same row can come down both paths, so dedupe by rowid, keep
 * newest-first order (id breaks timestamp ties — it's the insert order), and
 * cap the result so the feed never grows unbounded.
 */
export function mergeRecentActivity(
  existing: AgentEvent[],
  fetched: AgentEvent[],
  cap: number = ACTIVITY_FEED_CAP
): AgentEvent[] {
  if (fetched.length === 0 && existing.length <= cap) return existing;

  const byId = new Map<number, AgentEvent>();
  for (const e of existing) byId.set(e.id, e);
  for (const e of fetched) byId.set(e.id, e);

  return Array.from(byId.values())
    .sort((a, b) => b.timestamp - a.timestamp || b.id - a.id)
    .slice(0, cap);
}
