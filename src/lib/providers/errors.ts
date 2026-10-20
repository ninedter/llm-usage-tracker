/** Upstream rejected our credentials (HTTP 401/403), from any provider. */
export class UpstreamAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamAuthError";
  }
}
