import type { GrokUsageData } from "@/types";
import { getUsageLevel } from "../constants";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Decode the unpadded, lowercase RFC4648 base32 key in a .blob filename. */
export function decodeBlobKey(filename: string): string | null {
  if (!filename.endsWith(".blob")) return null;
  const encoded = filename.slice(0, -5);
  if (!encoded || /[^a-z2-7]/.test(encoded)) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of encoded) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 255);
      value &= (1 << bits) - 1;
    }
  }
  if (bits >= 5 || value !== 0) return null;
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    // Reject non-canonical encodings and binary names.
    if (decoded.includes("\0") || bytes.length === 0) return null;
    return decoded;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseGrokUsage(raw: unknown, now = Date.now()): GrokUsageData | null {
  const root = record(raw);
  const value = record(root?.value);
  if (value?.kind !== "present") return null;
  const reading = record(value.reading);
  const usage = record(reading?.usage);
  const percent = usage?.percentUsed;
  const readAt = iso(reading?.readAtMs);
  if (typeof percent !== "number" || !Number.isFinite(percent) || !readAt) return null;

  const resetTime = usage?.nextResetMs === null ? null : iso(usage?.nextResetMs);
  const windowReset = resetTime !== null && new Date(resetTime).getTime() < now;
  const percentage = Math.max(0, percent);
  const onDemand = record(usage?.onDemand);
  const usedCents = onDemand?.usedCents;
  const limitCents = onDemand?.limitCents;
  const validLimit = limitCents === null || (typeof limitCents === "number" && Number.isFinite(limitCents));

  return {
    planName: typeof usage?.unifiedPlanName === "string" ? usage.unifiedPlanName : "",
    planLabel: typeof usage?.grokPlanLabel === "string" ? usage.grokPlanLabel : "",
    weekly: windowReset ? null : {
      tokensUsed: 0,
      tokenLimit: 0,
      percentage,
      resetTime,
      level: getUsageLevel(percentage),
    },
    windowReset,
    isTrial: usage?.isSandTrial === true,
    onDemand: typeof usedCents === "number" && Number.isFinite(usedCents) && validLimit
      ? { used: usedCents / 100, limit: typeof limitCents === "number" ? limitCents / 100 : null, currency: "USD" }
      : null,
    readAt,
    stale: now - new Date(readAt).getTime() > DAY_MS,
    lastUpdated: readAt,
  };
}
