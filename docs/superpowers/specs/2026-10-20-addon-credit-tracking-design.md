# Add-on Credit Tracking — Design

**Date:** 2026-10-20 · **Status:** approved to build (user handed over control for exploration + code changes)

## Intent

Henry pays for add-on credits on top of both subscriptions — Claude Pro/Max
"extra usage" credits and ChatGPT Codex credits. The tracker already shows how
much of each subscription's rate-limit windows are used, but not how much
add-on credit is left, which is exactly what decides whether hitting a limit
means "wait" or "keep going and pay". The dashboard and the Monitor strip
should show remaining credit for both providers next to the quota bars.

The user also asked for a pass over "things that require updates / optimize
for better usage"; the review findings that make this feature reliable (or
that a user would trip over) are folded in below.

## Goals

- Claude card: prepaid credit balance (when available) and this month's extra
  usage — spent, monthly cap, remaining, % of cap, on/off.
- OpenAI card: Codex credit balance (number of credits, "Unlimited", or
  "Available"), and a "credits depleted" flag.
- Monitor strip: one compact credit figure per provider row.
- A credit-endpoint failure never breaks the quota card (credits are
  best-effort, exactly like OpenAI reset credits today).

## Non-goals

- API-key (console.anthropic.com / platform.openai.com) prepaid billing.
- Purchasing / auto-reload controls, history of credit balance over time,
  notifications.
- Retiring the Electron tooling or major dev-dep bumps (follow-up).

## Upstream data (undocumented endpoints; shapes from public sources)

Live probing with the user's tokens was blocked by the permission classifier,
so shapes come from the open-source Codex CLI and several independent
community trackers (CodexBar, ccusage, ccstatusline, TokenEater, PowerQuota).
Every field is treated as optional and parsing is defensive.

**OpenAI** — `GET chatgpt.com/backend-api/wham/usage` (already fetched):
`credits?: { has_credits: bool, unlimited: bool, balance?: string|null } | null`.
`balance` is a numeric string in **credits** (not dollars), may be fractional.
`rate_limit_reached_type` may be `workspace_owner_credits_depleted` /
`workspace_member_credits_depleted`. Display rule mirrors Codex TUI: unlimited →
"Unlimited"; has_credits with positive finite balance → "N credits"; has_credits
otherwise → "Available"; !has_credits → "None".

**Claude** — `extra_usage` block in both `api.anthropic.com/api/oauth/usage` and
`claude.ai/api/organizations/{org}/usage`:
`{ is_enabled?, monthly_limit?, used_credits?, utilization?, currency? }`.
Amounts are **minor units (cents) → divide by 100**. `monthly_limit` missing/null
= no cap. `utilization` 0–100 or null. `currency` ISO code, default `USD`.
Session-key-only endpoints (claude.ai):
- `GET /api/organizations/{org}/prepaid/credits` → `{ amount, currency }`,
  amount in cents = remaining prepaid balance. Reject negative/non-finite.
- `GET /api/organizations/{org}/overage_spend_limit` →
  `{ is_enabled?, monthly_credit_limit?, used_credits?, currency?, out_of_credits? }`,
  cents. 404 = no metered billing. Used to fill gaps in `extra_usage` and for
  `out_of_credits`.
Monthly reset is not reported; UI says "this month".

## Decisions (my calls)

- Parsing moves into pure, exported, unit-tested modules
  (`claude-parse.ts`, `openai-parse.ts`); clients only fetch.
- Claude works with OAuth token alone (fixes the "zero setup" path that was
  unreachable without a session key); prepaid balance needs a session key
  because only claude.ai exposes it.
- Cards are gated on "configured", not on "upstream succeeded": an expired
  token now shows its real error with the last good data instead of the
  "Configure credentials" placeholder, and polling continues.
- Refresh button bypasses the 30 s server cache (`?fresh=1`).
- All upstream fetches get a 10 s timeout. User-Agent strings become env
  overridable (`CLAUDE_CODE_USER_AGENT`, `CLAUDE_WEB_USER_AGENT`).
- Keychain probe becomes async (`execFile`, argument array, no shell), honors
  the token's `expiresAt`, and only 401/403 marks it suspect.
- Credential file decrypt is memoized in-process, invalidated on save/delete.
- OpenAI per-feature limits keep their secondary window too.
- CI adds typecheck, edge tests, and a production build; Next.js gets a 16.x
  patch bump, `@types/node` aligns with Node 22.

## Left to the builder

Visual details within the existing card language (zinc palette, `UsageBar`,
`UsageStat`), exact copy of secondary hints.
