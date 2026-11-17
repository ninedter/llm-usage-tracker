import { readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { GrokUsageData } from "@/types";
import { decodeBlobKey, parseGrokUsage } from "./grok-parse";

export function readGrokUsage(): GrokUsageData | null {
  const directory = process.env.GROK_BOT_CACHE_DIR ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "Grok Bot", "sand-client-persistence")
      : null);
  if (!directory) return null;
  try {
    // Decode every name first. Never open a blob whose key is not the usage cache.
    const matches = readdirSync(directory)
      .filter((name) => decodeBlobKey(name)?.endsWith(".weekly-usage.cache"))
      .map((name) => ({ name, mtime: statSync(join(directory, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!matches.length) return null;
    const raw = JSON.parse(readFileSync(join(directory, matches[0].name), "utf8"));
    return parseGrokUsage(raw);
  } catch {
    return null;
  }
}
