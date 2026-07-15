import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let tmpDir: string;
let projectsDir: string;

beforeAll(() => {
  // getDb() resolves LLM_DATA_DIR lazily on its first call, so pointing it at a
  // temp dir here keeps this suite off the real .data/agent-monitor.db.
  tmpDir = mkdtempSync(join(tmpdir(), "llm-usage-tracker-claude-"));
  projectsDir = mkdtempSync(join(tmpdir(), "llm-usage-tracker-transcripts-"));
  process.env.LLM_DATA_DIR = tmpDir;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(projectsDir, { recursive: true, force: true });
});

import { getDb, createSession } from "@/lib/db";
import { aggregateGroupUsage, parseClaudeTranscript } from "@/lib/providers/claude-transcript";
import { discoverSessionGroups, pollClaudeUsageOnce, recomputeSessionGroup } from "@/lib/providers/claude-watcher";

const SID = "11111111-2222-4333-8444-555555555555";
const SID2 = "99999999-8888-4777-8666-555555555555";

function assistantLine(o: {
  sid?: string; mid: string; model?: string;
  in?: number; out?: number; cr?: number; cw?: number;
  ts?: string; cwd?: string;
}): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: "assistant",
    sessionId: o.sid ?? SID,
    timestamp: o.ts ?? "2026-07-10T03:00:00.000Z",
    cwd: o.cwd ?? "/Users/me/myproj",
    entrypoint: "cli",
    message: {
      id: o.mid,
      model: o.model ?? "claude-fable-5",
      usage: {
        input_tokens: o.in ?? 0,
        output_tokens: o.out ?? 0,
        cache_read_input_tokens: o.cr ?? 0,
        cache_creation_input_tokens: o.cw ?? 0,
      },
    },
  });
}

const userLine = JSON.stringify({ type: "user", sessionId: SID, timestamp: "2026-07-10T02:59:00.000Z", message: { role: "user", content: "hi" } });

describe("parseClaudeTranscript", () => {
  it("extracts usage entries from assistant lines and skips everything else", () => {
    const text = [
      userLine,
      assistantLine({ mid: "m1", in: 100, out: 10, cr: 5, cw: 7 }),
      JSON.stringify({ type: "queue-operation", sessionId: SID, timestamp: "2026-07-10T03:01:00.000Z" }),
    ].join("\n") + "\n";

    const scan = parseClaudeTranscript(text);
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]).toMatchObject({
      sessionId: SID, messageId: "m1", model: "claude-fable-5",
      input_tokens: 100, output_tokens: 10, cache_read_tokens: 5, cache_write_tokens: 7,
    });
    expect(scan.sessionId).toBe(SID);
    expect(scan.cwd).toBe("/Users/me/myproj");
  });

  it("keeps the LAST line per message.id — streaming repeats a message's usage", () => {
    const text = [
      assistantLine({ mid: "m1", in: 100, out: 1 }),
      assistantLine({ mid: "m1", in: 100, out: 42 }), // final content-block line
      assistantLine({ mid: "m2", in: 50, out: 5 }),
    ].join("\n") + "\n";

    const totals = aggregateGroupUsage(SID, [parseClaudeTranscript(text)]);
    expect(totals).toHaveLength(1);
    expect(totals[0].input_tokens).toBe(150); // m1 counted once (100) + m2 (50)
    expect(totals[0].output_tokens).toBe(47); // 42 (last m1 line) + 5
  });

  it("skips synthetic models, usage-less assistants, and malformed lines", () => {
    const text = [
      assistantLine({ mid: "m1", model: "<synthetic>", in: 999 }),
      JSON.stringify({ type: "assistant", sessionId: SID, message: { id: "m2", model: "claude-fable-5" } }), // no usage
      '{"type":"assistant","sessionId":"' + SID + '","message":{"id":"m3"', // truncated tail
      assistantLine({ mid: "m4", in: 10, out: 2 }),
    ].join("\n") + "\n";

    const scan = parseClaudeTranscript(text);
    expect(scan.entries.map((e) => e.messageId)).toEqual(["m4"]);
  });

  it("tracks first/last timestamps across assistant lines", () => {
    const text = [
      assistantLine({ mid: "m1", ts: "2026-07-10T03:00:00.000Z" }),
      assistantLine({ mid: "m2", ts: "2026-07-10T05:30:00.000Z" }),
    ].join("\n") + "\n";
    const scan = parseClaudeTranscript(text);
    expect(scan.firstTs).toBe(Date.parse("2026-07-10T03:00:00.000Z"));
    expect(scan.lastTs).toBe(Date.parse("2026-07-10T05:30:00.000Z"));
  });
});

describe("aggregateGroupUsage", () => {
  it("sums per model across parent and subagent scans", () => {
    const parent = parseClaudeTranscript(assistantLine({ mid: "p1", in: 100, out: 10 }) + "\n");
    const sub = parseClaudeTranscript(
      [
        assistantLine({ mid: "a1", model: "claude-sonnet-5", in: 30, out: 3 }),
        assistantLine({ mid: "a2", model: "claude-fable-5", in: 20, out: 2, cr: 8 }),
      ].join("\n") + "\n"
    );

    const totals = aggregateGroupUsage(SID, [parent, sub]).sort((a, b) => a.model.localeCompare(b.model));
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ model: "claude-fable-5", input_tokens: 120, output_tokens: 12, cache_read_tokens: 8 });
    expect(totals[1]).toMatchObject({ model: "claude-sonnet-5", input_tokens: 30, output_tokens: 3 });
  });

  it("drops entries whose sessionId is not the group's — never clobber another session's totals", () => {
    const scan = parseClaudeTranscript(
      [
        assistantLine({ mid: "m1", in: 100 }),
        assistantLine({ mid: "m2", sid: SID2, in: 77 }),
      ].join("\n") + "\n"
    );
    const totals = aggregateGroupUsage(SID, [scan]);
    expect(totals).toHaveLength(1);
    expect(totals[0].input_tokens).toBe(100);
  });
});

describe("watcher: discover + recompute + poll", () => {
  const projDir = () => join(projectsDir, "-Users-me-myproj");

  beforeAll(() => {
    getDb();
    mkdirSync(join(projDir(), SID, "subagents"), { recursive: true });
    writeFileSync(
      join(projDir(), `${SID}.jsonl`),
      [userLine, assistantLine({ mid: "p1", in: 1000, out: 100, cr: 50, cw: 60 })].join("\n") + "\n"
    );
    writeFileSync(
      join(projDir(), SID, "subagents", "agent-abc123.jsonl"),
      assistantLine({ mid: "s1", model: "claude-sonnet-5", in: 200, out: 20 }) + "\n"
    );
  });

  it("groups the main transcript with its subagent files under one session", () => {
    const groups = discoverSessionGroups(projectsDir, 0);
    expect(groups).toHaveLength(1);
    expect(groups[0].sessionId).toBe(SID);
    expect(groups[0].files.map((f) => f.path).sort()).toEqual([
      join(projDir(), SID, "subagents", "agent-abc123.jsonl"),
      join(projDir(), `${SID}.jsonl`),
    ].sort());
  });

  it("recompute writes absolute anthropic token totals and a backfill session", () => {
    const [group] = discoverSessionGroups(projectsDir, 0);
    recomputeSessionGroup(group);

    const d = getDb();
    const rows = d.prepare("SELECT model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost FROM token_usage WHERE session_id = ? ORDER BY model").all(SID) as
      { model: string; provider: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost: number }[];
    expect(rows).toEqual([
      { model: "claude-fable-5", provider: "anthropic", input_tokens: 1000, output_tokens: 100, cache_read_tokens: 50, cache_write_tokens: 60, cost: 0 },
      { model: "claude-sonnet-5", provider: "anthropic", input_tokens: 200, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost: 0 },
    ]);

    const session = d.prepare("SELECT provider, project, status FROM sessions WHERE id = ?").get(SID) as
      { provider: string; project: string; status: string };
    expect(session).toEqual({ provider: "anthropic", project: "myproj", status: "completed" });

    // Idempotent: a second recompute REPLACEs with the same absolute values.
    recomputeSessionGroup(discoverSessionGroups(projectsDir, 0)[0]);
    const again = d.prepare("SELECT input_tokens FROM token_usage WHERE session_id = ? AND model = 'claude-fable-5'").get(SID) as { input_tokens: number };
    expect(again.input_tokens).toBe(1000);
  });

  it("poll skips clean groups and re-sums after new bytes arrive", () => {
    expect(pollClaudeUsageOnce(projectsDir, 0)).toBe(0); // cursors are current

    appendFileSync(join(projDir(), `${SID}.jsonl`), assistantLine({ mid: "p2", in: 500, out: 50 }) + "\n");
    expect(pollClaudeUsageOnce(projectsDir, 0)).toBe(1);

    const row = getDb().prepare("SELECT input_tokens, output_tokens FROM token_usage WHERE session_id = ? AND model = 'claude-fable-5'").get(SID) as
      { input_tokens: number; output_tokens: number };
    expect(row).toEqual({ input_tokens: 1500, output_tokens: 150 });
  });

  it("leaves hook-created sessions untouched", () => {
    const hookSid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    createSession(
      { id: hookSid, status: "active", project: "hook-proj", cwd: "/hook", entrypoint: "cli", started_at: Date.now(), ended_at: null, metadata: null },
      "anthropic"
    );
    writeFileSync(
      join(projDir(), `${hookSid}.jsonl`),
      assistantLine({ sid: hookSid, mid: "h1", in: 42, out: 4 }) + "\n"
    );

    pollClaudeUsageOnce(projectsDir, 0);

    const d = getDb();
    const session = d.prepare("SELECT status, project FROM sessions WHERE id = ?").get(hookSid) as { status: string; project: string };
    expect(session).toEqual({ status: "active", project: "hook-proj" }); // not overwritten
    const usage = d.prepare("SELECT input_tokens FROM token_usage WHERE session_id = ?").get(hookSid) as { input_tokens: number };
    expect(usage.input_tokens).toBe(42);
  });
});
