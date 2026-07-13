# OpenAI Usage Tracking — Design

**Date:** 2026-07-13
**Status:** Implemented (autonomous session — review welcome)

## Goal

Add an OpenAI usage card to the dashboard alongside the existing Claude card, so the
app tracks both providers' subscription quota windows.

## What "OpenAI usage" means here

The existing Claude card tracks **subscription quota utilization** (5-hour / 7-day
windows as percentages), not API billing. The direct OpenAI equivalent is the
**ChatGPT/Codex rate-limit windows** exposed by `https://chatgpt.com/backend-api/wham/usage`.

Evidence from this machine that drove the decision:

- Codex CLI is installed (`/opt/homebrew/bin/codex`) with active ChatGPT OAuth
  credentials in `~/.codex/auth.json` (`auth_mode: "chatgpt"`, no API key stored).
- No `OPENAI_API_KEY` in the environment.
- The endpoint was verified live: returns `plan_type`, `rate_limit.primary_window`
  (`used_percent`, `limit_window_seconds`, `reset_at`), optional `secondary_window`,
  and `additional_rate_limits` (per-feature windows, e.g. "GPT-5.3-Codex-Spark").

## Approaches considered

1. **ChatGPT/Codex quota via Codex CLI OAuth token (chosen)** — zero-config (reads
   `~/.codex/auth.json`, mirroring how `ClaudeClient` reads the Claude Code OAuth token
   from the macOS Keychain), percentage windows map 1:1 onto the existing `UsageBar` UI.
   Unofficial endpoint, but it is what Codex CLI itself uses for `/status`.
2. **OpenAI Platform Admin API (`/v1/organization/usage`, `/v1/organization/costs`)** —
   official, but requires creating an org Admin key the user doesn't have, and reports
   dollar costs rather than quota percentages, which doesn't match the app's dashboard
   model. Deferred as a possible future enhancement.
3. **Manual session-token entry (like the Claude sessionKey flow)** — unnecessary
   while auto-detection works; adds credential-management surface for no gain.

## Architecture (mirrors the Claude provider end-to-end)

| Piece | Claude (existing) | OpenAI (new) |
|---|---|---|
| Client | `src/lib/providers/claude-client.ts` | `src/lib/providers/openai-client.ts` |
| Usage route | `GET /api/usage/claude` | `GET /api/usage/openai` |
| Health | `ProviderHealth.claude` | `ProviderHealth.openai` |
| Hook | `useClaudeUsage` | `useOpenAIUsage` |
| Card | `ClaudeCard.tsx` | `OpenAICard.tsx` |

- **Credentials:** none stored. `OpenAIClient.readCodexAuth()` reads
  `~/.codex/auth.json` at request time (access token + account id). If the file is
  missing → "not configured" state telling the user to run `codex login`. If the
  endpoint returns 401 → error telling the user to run `codex` to refresh the token
  (Codex CLI manages its own refresh; this app never writes to `auth.json`).
- **Types:** `ProviderId` becomes `"claude" | "openai"`. New `OpenAIRateWindow`
  (`label`, `windowSeconds`, `percentage`, `resetTime`, `level`) and `OpenAIUsageData`
  (`planType`, `windows[]`, `featureLimits[]`, `lastUpdated`). Windows are a list
  rather than fixed session/weekly fields because plans differ (this account has only
  a 7-day primary window; Plus/Pro plans also have a 5-hour window).
- **Parsing:** `used_percent` → percentage + `getUsageLevel()`; `reset_at` (unix
  seconds) → ISO string; `limit_window_seconds` → human label ("5-Hour Window",
  "7-Day Window", generic fallback). `additional_rate_limits` → `featureLimits`
  rendered like the Claude card's per-model breakdown.
- **UI:** `OpenAICard` reuses `ProviderCard` + `UsageBar`; plan type shown in the
  footer. `DashboardGrid` stacks both cards. `ProviderStatus` lists both providers.
  Settings gets an info block for OpenAI (auto-detected, nothing to configure).

## Error handling

- Missing `~/.codex/auth.json` → health `connected: false`, card shows setup hint.
- 401/403 from endpoint → actionable error ("run `codex` to refresh").
- Malformed/partial response → windows default to empty; card still renders.

## Testing

The project has no test infrastructure; verification follows the repo's existing
practice: `npm run build` (type-checks strictly) plus a live end-to-end check that
`GET /api/usage/openai` returns real data and the dashboard renders both cards.
