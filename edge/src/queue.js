/**
 * Durable, append-only spool.
 *
 * One JSON object per line under the edge data dir. Append is a single
 * `appendFileSync` so an event survives a crash the moment intake returns 202;
 * acknowledging a shipped batch rewrites the file through a temp file +
 * rename, so a kill mid-compaction leaves either the old spool (events ship
 * twice, and the hub's `source_id` index drops the replay) or the new one —
 * never a truncated line.
 *
 * JSONL rather than SQLite on purpose: no native module to rebuild per
 * platform, and the file is greppable when someone has to debug a machine that
 * has been offline for a week.
 */
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_EVENTS = 100_000;
/** How many already-shipped ids to remember, so a hook double-post is caught locally. */
const DEFAULT_RECENT_IDS = 5_000;
/** Compact a capped spool in batches: rewriting 100k lines per dropped event
 *  would make a long offline stretch quadratic. Until the rewrite, the file
 *  simply holds a few extra old lines, and `load()` re-applies the cap. */
const COMPACT_AFTER_DROPS = 100;

export class Queue {
  constructor(opts = {}) {
    this.path = opts.path;
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.recentCapacity = opts.recentIds ?? DEFAULT_RECENT_IDS;
    this.onDrop = opts.onDrop ?? (() => {});
    /** @type {{source_id: string, event: object}[]} */
    this.entries = [];
    this.pendingIds = new Set();
    /** Insertion-ordered, bounded: a Set is enough to evict oldest-first. */
    this.recentIds = new Set();
    this.droppedTotal = 0;
    this.shippedTotal = 0;
    this.dropsSinceRewrite = 0;
  }

  /** Read the spool from disk. Malformed lines are skipped, not fatal. */
  load() {
    this.entries = [];
    this.pendingIds = new Set();
    if (!this.path || !fs.existsSync(this.path)) return this;
    const text = fs.readFileSync(this.path, "utf8");
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== "object" || !entry.event || typeof entry.source_id !== "string") {
          skipped++;
          continue;
        }
        if (this.pendingIds.has(entry.source_id)) continue;
        this.entries.push(entry);
        this.pendingIds.add(entry.source_id);
      } catch {
        // A half-written final line from an unclean shutdown: drop that one
        // event rather than refuse to start and lose the whole backlog.
        skipped++;
      }
    }
    if (skipped) this.onDrop({ reason: "malformed_line", count: skipped });
    this.#enforceCap();
    return this;
  }

  size() {
    return this.entries.length;
  }

  /**
   * Add one normalized event.
   * @returns {{queued: boolean, duplicate: boolean, source_id: string}}
   */
  enqueue(event) {
    const sourceId = event.source_id;
    if (this.pendingIds.has(sourceId) || this.recentIds.has(sourceId)) {
      return { queued: false, duplicate: true, source_id: sourceId };
    }
    const entry = { source_id: sourceId, event };
    this.entries.push(entry);
    this.pendingIds.add(sourceId);
    this.#append(entry);
    this.#enforceCap();
    return { queued: true, duplicate: false, source_id: sourceId };
  }

  /** The oldest `n` entries' events, in spool order. */
  peek(n) {
    return this.entries.slice(0, Math.max(0, n)).map((e) => e.event);
  }

  /** Drop the given ids (shipped, or rejected as unshippable) and rewrite the spool. */
  ack(sourceIds) {
    const ids = new Set(sourceIds);
    if (!ids.size) return 0;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !ids.has(e.source_id));
    for (const id of ids) {
      this.pendingIds.delete(id);
      this.#remember(id);
    }
    const removed = before - this.entries.length;
    this.shippedTotal += removed;
    this.#rewrite();
    return removed;
  }

  stats() {
    return {
      queued: this.entries.length,
      oldest_ts: this.entries.length ? this.entries[0].event.timestamp : null,
      shipped_total: this.shippedTotal,
      dropped_total: this.droppedTotal,
      spool_path: this.path,
    };
  }

  /** Oldest-first eviction: a machine that has been offline for a month must
   *  not fill its disk, and the newest events are the ones worth keeping. */
  #enforceCap() {
    if (this.entries.length <= this.maxEvents) return;
    const overflow = this.entries.length - this.maxEvents;
    const dropped = this.entries.splice(0, overflow);
    for (const entry of dropped) this.pendingIds.delete(entry.source_id);
    this.droppedTotal += dropped.length;
    this.dropsSinceRewrite += dropped.length;
    this.onDrop({ reason: "queue_full", count: dropped.length });
    if (this.dropsSinceRewrite >= COMPACT_AFTER_DROPS) this.#rewrite();
  }

  #remember(id) {
    this.recentIds.add(id);
    if (this.recentIds.size > this.recentCapacity) {
      const oldest = this.recentIds.values().next().value;
      this.recentIds.delete(oldest);
    }
  }

  #append(entry) {
    if (!this.path) return;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  #rewrite() {
    if (!this.path) return;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.dropsSinceRewrite = 0;
    const tmp = this.path + ".tmp";
    const body = this.entries.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(tmp, body ? body + "\n" : "");
    fs.renameSync(tmp, this.path);
  }
}
