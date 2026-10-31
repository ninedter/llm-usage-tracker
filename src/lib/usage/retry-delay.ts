import { REFRESH_INTERVALS } from "@/lib/constants";

/**
 * Delay before SWR retries a failed usage fetch.
 *
 * SWR suppresses `refreshInterval` polling while an error is cached, so
 * onErrorRetry is the only thing keeping a failed card alive:
 * - MISSING_CREDENTIALS can't be fixed by hammering the route, but the user
 *   may add credentials at any moment — keep checking at the normal poll rate.
 * - Anything else uses SWR's jittered exponential backoff, capped at the poll
 *   rate so a transient outage never stalls the card for ~20 minutes.
 */
export function usageRetryDelay(
  code: string | undefined,
  retryCount: number,
  retryIntervalMs = 5_000,
  random: () => number = Math.random
): number {
  if (code === "MISSING_CREDENTIALS") return REFRESH_INTERVALS.usage;
  const backoff = ~~((random() + 0.5) * (1 << Math.min(retryCount, 8))) * retryIntervalMs;
  return Math.min(backoff, REFRESH_INTERVALS.usage);
}

const pendingRetries = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule `fn` after `delayMs`, keeping at most one pending retry per key.
 *
 * SWR starts a fresh retry chain for every failed non-deduped request, and a
 * focus revalidation or manual Refresh issues one while an earlier chain's
 * timer is still pending. Because usage retries never give up, those chains
 * would otherwise stack — K focus events ≈ K upstream requests per minute.
 */
export function scheduleRetry(key: string, delayMs: number, fn: () => void): void {
  const pending = pendingRetries.get(key);
  if (pending !== undefined) clearTimeout(pending);
  const timer = setTimeout(() => {
    pendingRetries.delete(key);
    fn();
  }, delayMs);
  pendingRetries.set(key, timer);
}
