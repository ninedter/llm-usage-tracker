import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readGrokUsage } from "../grok-client";

const dirs: string[] = [];
const key = (name: string) => {
  const bytes = Buffer.from(name);
  const chars = "abcdefghijklmnopqrstuvwxyz234567";
  let value = 0, bits = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += chars[(value >> bits) & 31];
      value &= (1 << bits) - 1;
    }
  }
  if (bits) out += chars[(value << (5 - bits)) & 31];
  return `${out}.blob`;
};
const fixture = (percent: number) => JSON.stringify({ value: { kind: "present", reading: {
  readAtMs: Date.now(), usage: { percentUsed: percent, nextResetMs: Date.now() + 100000 },
} } });
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-cache-"));
  dirs.push(dir);
  vi.stubEnv("GROK_BOT_CACHE_DIR", dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("readGrokUsage", () => {
  it("uses the env override and never opens a transcript blob", () => {
    const dir = temp();
    const transcript = key("sand.client.slice.account.slot.chat-transcript.cache");
    writeFileSync(join(dir, transcript), "private transcript");
    writeFileSync(join(dir, key("sand.client.slice.account.slot.weekly-usage.cache")), fixture(12));
    utimesSync(join(dir, transcript), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expect(readGrokUsage()?.weekly?.percentage).toBe(12);
  });
  it("chooses the newest matching account", () => {
    const dir = temp();
    const a = join(dir, key("sand.client.slice.account.one.weekly-usage.cache"));
    const b = join(dir, key("sand.client.slice.account.two.weekly-usage.cache"));
    writeFileSync(a, fixture(10));
    writeFileSync(b, fixture(20));
    utimesSync(a, new Date(1000), new Date(1000));
    expect(readGrokUsage()?.weekly?.percentage).toBe(20);
  });
  it("returns null for missing directory or malformed usage", () => {
    vi.stubEnv("GROK_BOT_CACHE_DIR", join(tmpdir(), "grok-missing-fixture"));
    expect(readGrokUsage()).toBeNull();
    const dir = temp();
    writeFileSync(join(dir, key("sand.client.slice.account.slot.weekly-usage.cache")), "not json");
    expect(readGrokUsage()).toBeNull();
  });
});
