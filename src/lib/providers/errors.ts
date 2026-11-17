/** Upstream rejected our credentials (HTTP 401/403), from any provider. */
export class UpstreamAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamAuthError";
  }
}

/** Shared by the client and the usage service, which both detect a lapsed Keychain token. */
export const CLAUDE_OAUTH_EXPIRED_MESSAGE =
  "Claude Code sign-in expired. Run `claude` in a terminal to refresh it.";
