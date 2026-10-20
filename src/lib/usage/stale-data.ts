/**
 * SWR keeps the last good data while a request fails. That's right for a
 * transient error, but once a provider reports MISSING_CREDENTIALS the data
 * belongs to credentials that no longer exist, so compact views drop it
 * (the dashboard cards switch to their setup placeholder instead).
 */
export function dataUnlessUnconfigured<T>(
  data: T | undefined,
  error: { code?: string } | undefined
): T | undefined {
  return error?.code === "MISSING_CREDENTIALS" ? undefined : data;
}
