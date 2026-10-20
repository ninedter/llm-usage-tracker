import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { OpenAIUsageData } from "@/types";
import {
  parseOpenAIUsage,
  type WhamResetCreditsResponse,
  type WhamUsageResponse,
} from "./openai-parse";

export class OpenAIClient {
  constructor(
    private accessToken: string,
    private accountId: string
  ) {}

  /**
   * Read Codex CLI's ChatGPT OAuth credentials from $CODEX_HOME/auth.json
   * (defaults to ~/.codex, matching Codex CLI's own convention — in Docker the
   * host's ~/.codex is mounted read-only and CODEX_HOME points at it).
   * Returns null if the user hasn't logged in with `codex login`.
   * The token is refreshed by Codex CLI itself; this app never writes back.
   */
  static readCodexAuth(): { accessToken: string; accountId: string } | null {
    try {
      const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
      const raw = readFileSync(join(codexHome, "auth.json"), "utf8");
      const auth = JSON.parse(raw);
      const accessToken = auth?.tokens?.access_token;
      const accountId = auth?.tokens?.account_id;
      if (typeof accessToken === "string" && typeof accountId === "string") {
        return { accessToken, accountId };
      }
      return null;
    } catch {
      return null;
    }
  }

  async fetchUsage(): Promise<OpenAIUsageData> {
    // Reset-credit details are best-effort — the card still renders if only
    // the usage endpoint succeeds
    const [usage, resetCredits] = await Promise.all([
      this.getJson<WhamUsageResponse>("https://chatgpt.com/backend-api/wham/usage"),
      this.getJson<WhamResetCreditsResponse>(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
      ).catch(() => null),
    ]);

    return parseOpenAIUsage(usage, resetCredits);
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "chatgpt-account-id": this.accountId,
        Accept: "application/json",
        "User-Agent": "codex-cli",
      },
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Codex session token expired or invalid (${res.status}). Run \`codex\` in a terminal to refresh it.`
        );
      }
      throw new Error(`ChatGPT usage API returned ${res.status}`);
    }

    return res.json() as Promise<T>;
  }
}
