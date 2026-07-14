import type { DbProvider } from "@/types";

/**
 * Read a validated `?provider=` filter off a request URL.
 *
 * Anything unrecognised (including absent, "", or "all") means *no* filter —
 * i.e. show every provider — so the All tab and old clients that don't send the
 * param behave identically.
 */
export function readProvider(url: URL): DbProvider | undefined {
  const p = url.searchParams.get("provider");
  return p === "openai" || p === "anthropic" ? p : undefined;
}
