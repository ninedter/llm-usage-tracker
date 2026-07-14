import { describe, it, expect } from "vitest";
import { scanDirsForTick } from "@/lib/providers/codex-watcher";

function localDayDir(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

describe("scanDirsForTick", () => {
  it("requests a full walk when 60s have passed", () => {
    const now = Date.parse("2026-07-14T12:00:00");
    expect(scanDirsForTick(now, now - 61_000)).toBe("full");
  });

  it("scans only today's dir between full walks", () => {
    const now = new Date("2026-07-14T12:00:00").getTime();
    expect(scanDirsForTick(now, now - 4_000)).toEqual([localDayDir(new Date(now))]);
  });

  it("includes yesterday within the first hour after midnight", () => {
    const now = new Date("2026-07-14T00:30:00").getTime();
    const dirs = scanDirsForTick(now, now - 4_000) as string[];
    expect(dirs).toContain(localDayDir(new Date(now)));
    expect(dirs).toContain(localDayDir(new Date(now - 86400000)));
  });
});
