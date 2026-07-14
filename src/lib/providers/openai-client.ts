import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { OpenAIRateWindow, OpenAIResetCredit, OpenAIUsageData } from "@/types";
import { getUsageLevel } from "../constants";

// Response from chatgpt.com/backend-api/wham/usage — the endpoint Codex CLI
// uses for its /status rate-limit display.
interface WhamWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number; // unix seconds
}

interface WhamRateLimit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: WhamWindow | null;
  secondary_window?: WhamWindow | null;
}

interface WhamUsageResponse {
  plan_type?: string;
  rate_limit?: WhamRateLimit | null;
  additional_rate_limits?: Array<{
    limit_name?: string;
    rate_limit?: WhamRateLimit | null;
  }> | null;
  rate_limit_reset_credits?: { available_count?: number } | null;
}

// Response from chatgpt.com/backend-api/wham/rate-limit-reset-credits — the
// endpoint Codex CLI uses to list individual reset credits.
interface WhamResetCredit {
  id?: string;
  status?: string;
  expires_at?: string | null;
  title?: string | null;
}

interface WhamResetCreditsResponse {
  credits?: WhamResetCredit[] | null;
  available_count?: number;
}

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
};

function windowLabel(seconds: number | undefined): string {
  if (!seconds) return "Usage Window";
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return days === 1 ? "1-Day Window" : `${days}-Day Window`;
  }
  const hours = Math.round(seconds / 3600);
  return hours === 1 ? "1-Hour Window" : `${hours}-Hour Window`;
}

function parseWindow(
  win: WhamWindow | null | undefined,
  label?: string
): OpenAIRateWindow | null {
  if (!win || win.used_percent == null) return null;
  const pct = win.used_percent;
  return {
    label: label ?? windowLabel(win.limit_window_seconds),
    windowSeconds: win.limit_window_seconds ?? 0,
    percentage: pct,
    resetTime:
      win.reset_at != null ? new Date(win.reset_at * 1000).toISOString() : null,
    level: getUsageLevel(pct),
  };
}

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
    const [usage, credits] = await Promise.all([
      this.getJson<WhamUsageResponse>("https://chatgpt.com/backend-api/wham/usage"),
      this.getJson<WhamResetCreditsResponse>(
        "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
      ).catch(() => null),
    ]);

    return this.parseUsageResponse(usage, credits);
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

  private parseUsageResponse(
    usage: WhamUsageResponse,
    creditDetails: WhamResetCreditsResponse | null
  ): OpenAIUsageData {
    const windows: OpenAIRateWindow[] = [];
    const primary = parseWindow(usage.rate_limit?.primary_window);
    const secondary = parseWindow(usage.rate_limit?.secondary_window);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    // Show the shorter window first, matching the Claude card's 5h-then-7d order
    windows.sort((a, b) => a.windowSeconds - b.windowSeconds);

    const featureLimits: OpenAIRateWindow[] = [];
    for (const extra of usage.additional_rate_limits ?? []) {
      const win = parseWindow(extra.rate_limit?.primary_window, extra.limit_name);
      if (win) featureLimits.push(win);
    }

    const rawPlan = usage.plan_type ?? "";
    const planType =
      PLAN_NAMES[rawPlan] ??
      (rawPlan ? rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1) : "");

    const resetCredits: OpenAIResetCredit[] = (creditDetails?.credits ?? [])
      .filter((c) => c.status === "available")
      .map((c, i) => ({
        id: c.id ?? `credit-${i}`,
        title: c.title || "Rate-limit reset",
        expiresAt: c.expires_at ?? null,
      }));

    const availableCount =
      creditDetails?.available_count ?? usage.rate_limit_reset_credits?.available_count;

    return {
      planType,
      windows,
      featureLimits,
      resetCreditsAvailable: typeof availableCount === "number" ? availableCount : null,
      resetCredits,
      lastUpdated: new Date().toISOString(),
    };
  }
}
