/**
 * Where the browser and the edge machines point at the hub.
 *
 * The hub is a Docker/web deployment reached over the tailnet, so this is the
 * one host the product knows about. `NEXT_PUBLIC_HUB_URL` overrides it; nothing
 * else in the app hardcodes a hostname.
 */
export const DEFAULT_HUB_URL = "http://henrys-mac-mini:3789";

/**
 * Server-side read of the configured hub URL.
 *
 * Next.js inlines `NEXT_PUBLIC_*` at *build* time, so a client component that
 * read `process.env.NEXT_PUBLIC_HUB_URL` directly would show whatever the image
 * was built with, not what the container was started with. Settings therefore
 * fetches `GET /api/hub-info`, which calls this at request time.
 */
export function getHubUrl(): string {
  return process.env.NEXT_PUBLIC_HUB_URL || DEFAULT_HUB_URL;
}
