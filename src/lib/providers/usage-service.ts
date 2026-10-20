import { getCredentials } from "@/lib/credentials";
import { ClaudeClient, type ClaudeSessionCreds } from "./claude-client";
import { OpenAIClient } from "./openai-client";
import { CLAUDE_OAUTH_EXPIRED_MESSAGE, UpstreamAuthError } from "./errors";
import { claudeUsageCache, openaiUsageCache } from "./usage-cache";
import type { ClaudeUsageData, OpenAIUsageData } from "@/types";

export type UsageErrorCode = "MISSING_CREDENTIALS" | "AUTH_EXPIRED" | "FETCH_ERROR";
export type UsageResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: UsageErrorCode; message: string; status: 401 | 502 };

interface UsageOpts {
  /** Bypass the server-side TTL cache and refetch from upstream. */
  fresh?: boolean;
}

const CLAUDE_MISSING =
  "No Claude credentials: save a claude.ai session key in Settings or sign in to Claude Code.";
const OPENAI_MISSING =
  "Codex CLI login not found (~/.codex/auth.json). Run `codex login` to connect your ChatGPT account.";

function missing<T>(message: string): UsageResult<T> {
  return { ok: false, code: "MISSING_CREDENTIALS", message, status: 401 };
}

function toFailure<T>(error: unknown, fallback: string): UsageResult<T> {
  const message = error instanceof Error ? error.message : fallback;
  if (error instanceof UpstreamAuthError) {
    return { ok: false, code: "AUTH_EXPIRED", message, status: 401 };
  }
  return { ok: false, code: "FETCH_ERROR", message, status: 502 };
}

function savedClaudeSession(): ClaudeSessionCreds | null {
  const claude = getCredentials().claude;
  if (!claude?.sessionKey || !claude?.organizationId) return null;
  return { sessionKey: claude.sessionKey, organizationId: claude.organizationId };
}

export async function getClaudeUsage(
  opts: UsageOpts = {}
): Promise<UsageResult<ClaudeUsageData>> {
  try {
    const session = savedClaudeSession();
    if (!session) {
      const oauth = await ClaudeClient.readClaudeCodeOAuthState();
      // Signed in once but the token lapsed: that's configured-but-expired, not
      // "no credentials" — the card keeps its last data and shows the real error
      if (oauth.expired) {
        return { ok: false, code: "AUTH_EXPIRED", message: CLAUDE_OAUTH_EXPIRED_MESSAGE, status: 401 };
      }
      if (!oauth.token) return missing(CLAUDE_MISSING);
    }
    if (opts.fresh) claudeUsageCache.invalidate("claude");
    const data = await claudeUsageCache.get("claude", () =>
      new ClaudeClient(session).fetchUsage()
    );
    return { ok: true, data };
  } catch (error) {
    return toFailure(error, "Failed to fetch Claude usage");
  }
}

export async function getOpenAIUsage(
  opts: UsageOpts = {}
): Promise<UsageResult<OpenAIUsageData>> {
  try {
    const auth = OpenAIClient.readCodexAuth();
    if (!auth) return missing(OPENAI_MISSING);
    if (opts.fresh) openaiUsageCache.invalidate("openai");
    const data = await openaiUsageCache.get("openai", () =>
      new OpenAIClient(auth.accessToken, auth.accountId).fetchUsage()
    );
    return { ok: true, data };
  } catch (error) {
    return toFailure(error, "Failed to fetch OpenAI usage");
  }
}
