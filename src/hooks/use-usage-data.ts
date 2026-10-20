"use client";

import useSWR, { mutate, type SWRConfiguration } from "swr";
import type {
  ApiResponse,
  ClaudeUsageData,
  OpenAIUsageData,
  ProviderHealth,
} from "@/types";
import { REFRESH_INTERVALS } from "@/lib/constants";

const CLAUDE_USAGE_KEY = "/api/usage/claude";
const OPENAI_USAGE_KEY = "/api/usage/openai";
const HEALTH_KEY = "/api/health";

/** Fetch failure carrying the route's error code (e.g. MISSING_CREDENTIALS). */
export class UsageFetchError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "UsageFetchError";
    this.code = code;
  }
}

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  let json: ApiResponse<T>;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body (proxy error page, dev-server crash): keep the status visible
    throw new UsageFetchError(`Fetch failed (HTTP ${res.status})`);
  }
  if (!json.success) {
    throw new UsageFetchError(json.error?.message ?? "Fetch failed", json.error?.code);
  }
  return json.data as T;
}

// Retrying can't fix missing credentials — the user has to add them — so skip
// the backoff loop for that code and keep SWR's default backoff otherwise.
const onErrorRetry: SWRConfiguration["onErrorRetry"] = (
  error: UsageFetchError,
  _key,
  config,
  revalidate,
  { retryCount }
) => {
  if (error.code === "MISSING_CREDENTIALS") return;
  const max = config.errorRetryCount;
  if (max !== undefined && retryCount > max) return;
  const timeout =
    ~~((Math.random() + 0.5) * (1 << Math.min(retryCount, 8))) * config.errorRetryInterval;
  setTimeout(revalidate, timeout, { retryCount });
};

const usageConfig: SWRConfiguration = {
  refreshInterval: REFRESH_INTERVALS.usage,
  revalidateOnFocus: true,
  onErrorRetry,
};

// Always fetch: the route itself reports MISSING_CREDENTIALS, which is more
// accurate than gating on /api/health (and avoids a second round trip first).
export function useClaudeUsage() {
  return useSWR<ClaudeUsageData, UsageFetchError>(CLAUDE_USAGE_KEY, fetcher, usageConfig);
}

export function useOpenAIUsage() {
  return useSWR<OpenAIUsageData, UsageFetchError>(OPENAI_USAGE_KEY, fetcher, usageConfig);
}

export function useHealth() {
  return useSWR<ProviderHealth, UsageFetchError>(HEALTH_KEY, fetcher, {
    refreshInterval: REFRESH_INTERVALS.billing,
    revalidateOnFocus: true,
  });
}

/**
 * Manual refresh: bypass the 30 s server cache (`?fresh=1`) for usage so the
 * button shows upstream truth, not a cached copy. SWR's follow-up revalidation
 * then reads the just-refreshed server cache, and on failure surfaces the error
 * through the hook. allSettled so one failing provider doesn't block the others.
 */
export async function refreshUsage(): Promise<void> {
  await Promise.allSettled([
    ...[CLAUDE_USAGE_KEY, OPENAI_USAGE_KEY].map((key) =>
      mutate(key, fetcher(`${key}?fresh=1`))
    ),
    mutate(HEALTH_KEY),
  ]);
}
