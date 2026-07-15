import { describe, it, expect } from "vitest";
import { mergeRecentActivity } from "@/lib/activity-merge";
import type { AgentEvent, DbProvider } from "@/types";

const ev = (id: number, timestamp: number, provider: DbProvider = "openai"): AgentEvent => ({
  id,
  agent_id: `a-${id}`,
  session_id: `s-${id}`,
  provider,
  source_id: null,
  event_type: "tool_call",
  tool_name: "exec",
  summary: `event ${id}`,
  content: null,
  files_affected: null,
  timestamp,
  created_at: timestamp,
});

describe("mergeRecentActivity", () => {
  it("hydrates an empty feed with fetched events, newest first", () => {
    const fetched = [ev(3, 3000), ev(2, 2000), ev(1, 1000)];
    expect(mergeRecentActivity([], fetched).map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it("keeps SSE-arrived events that the fetch has not caught up to yet", () => {
    const live = [ev(9, 9000)]; // arrived over SSE while the fetch was in flight
    const fetched = [ev(3, 3000), ev(2, 2000)];
    expect(mergeRecentActivity(live, fetched).map((e) => e.id)).toEqual([9, 3, 2]);
  });

  it("dedupes rows delivered by both SSE and the fetch", () => {
    const live = [ev(3, 3000), ev(2, 2000)];
    const fetched = [ev(3, 3000), ev(2, 2000), ev(1, 1000)];
    expect(mergeRecentActivity(live, fetched).map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it("orders same-timestamp events by id, newest insert first", () => {
    const merged = mergeRecentActivity([ev(5, 1000)], [ev(7, 1000), ev(6, 1000)]);
    expect(merged.map((e) => e.id)).toEqual([7, 6, 5]);
  });

  it("caps the result at the given size, dropping the oldest", () => {
    const fetched = Array.from({ length: 10 }, (_, i) => ev(10 - i, (10 - i) * 1000));
    const merged = mergeRecentActivity([ev(99, 99_000)], fetched, 5);
    expect(merged).toHaveLength(5);
    expect(merged.map((e) => e.id)).toEqual([99, 10, 9, 8, 7]);
  });

  it("is a no-op when the fetch returns nothing new", () => {
    const live = [ev(2, 2000), ev(1, 1000)];
    expect(mergeRecentActivity(live, []).map((e) => e.id)).toEqual([2, 1]);
  });
});
