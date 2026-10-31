# Add-on Credit Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show remaining Claude extra-usage / prepaid credit and Codex credit balance on the dashboard and Monitor strip, and harden the usage pipeline those numbers flow through.

**Architecture:** Pure, exported parsers turn raw provider JSON into typed data (`claude-parse.ts`, `openai-parse.ts`). Clients only fetch (with timeouts; credit endpoints best-effort). A small `usage-service.ts` owns credentials → client → TTL cache → typed result, and the usage routes and health route become thin wrappers. The UI always calls the usage hooks and renders "not configured" only for `MISSING_CREDENTIALS`.

**Tech Stack:** Next.js 16 route handlers, React 19, SWR, Tailwind 4, Vitest 2, TypeScript 5.

**Spec:** `docs/superpowers/specs/2026-10-20-addon-credit-tracking-design.md` (read it first — it has the upstream field shapes and units).

## Global Constraints

- Every upstream field is optional; parsers never throw on missing/garbage fields.
- Claude amounts are cents on the wire → divide by 100. OpenAI `balance` is a numeric string in credits (not money).
- Credit endpoint failures (`prepaid/credits`, `overage_spend_limit`) must never fail the usage fetch: `.catch(() => null)`.
- Upstream fetch timeout: `UPSTREAM_TIMEOUT_MS = 10_000` (in `src/lib/constants.ts`), applied with `AbortSignal.timeout`.
- Match existing style: 2-space indent, double quotes, zinc Tailwind palette with `dark:` variants, comments explain *why*.
- Run from the worktree root. Verification commands: `npx vitest run <path>`, `npx tsc --noEmit`, `npm run lint`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Extra usage enabled with no monthly cap (`monthly_limit` null/missing) → show spent amount, "no monthly cap", no bar, `remaining: null`. (Task 1 test)
2. Non-USD currency (e.g. `CAD`, lower-case `cad`) → formatted with that currency, upper-cased. (Tasks 1, 5 tests)
3. OpenAI `balance` `"0"`, `""`, `"abc"`, or `null` while `has_credits` is true → "Available", not "0 credits"/NaN. (Tasks 2, 5 tests)
4. OAuth-only Claude (no session key saved) → usage works, `prepaidBalance: null`, no network call to claude.ai. (Task 3 test)
5. Expired Codex/Claude token after a good fetch → card keeps last data and shows the auth error; it does not flip to the "configure credentials" placeholder. (Task 4 route test + Task 5 manual check)

---

### Task 1: Credit types + Claude parser

**Files:**
- Modify: `src/types/index.ts` (remove unused `BillingInfo` + `ClaudeUsageData.billing`; add types below)
- Create: `src/lib/providers/claude-parse.ts` (move `UsageResponse`/`UsageBucket`/`UsageLimit` interfaces and the body of `ClaudeClient.parseUsageResponse` here)
- Modify: `src/lib/providers/claude-client.ts` (call `parseClaudeUsage`; delete the private parser)
- Modify: `src/lib/usage/__tests__/windows.test.ts` (fixture gains `extraUsage: null, prepaidBalance: null`)
- Test: `src/lib/providers/__tests__/claude-parse.test.ts`

**Interfaces — Produces:**
```ts
// src/types/index.ts
export interface MoneyAmount { amount: number; currency: string } // major units, ISO upper-case
export interface ClaudeExtraUsage {
  enabled: boolean;
  currency: string;            // default "USD"
  monthlyLimit: number | null; // major units; null = no cap
  used: number;                // major units; 0 when missing
  remaining: number | null;    // max(0, monthlyLimit - used); null when no cap
  percentage: number | null;   // utilization if finite, else used/limit*100, else null
  level: UsageLevel;           // getUsageLevel(percentage ?? 0)
  outOfCredits: boolean;       // spendLimit.out_of_credits, else percentage >= 100
}
// ClaudeUsageData gains:
  extraUsage: ClaudeExtraUsage | null;
  prepaidBalance: MoneyAmount | null;

// src/lib/providers/claude-parse.ts
export interface ClaudeUsageResponse { /* existing UsageResponse fields */ extra_usage?: ClaudeExtraUsageRaw | null }
export interface ClaudeExtraUsageRaw { is_enabled?: boolean | null; monthly_limit?: number | null; used_credits?: number | null; utilization?: number | null; currency?: string | null }
export interface ClaudePrepaidRaw { amount?: number | null; currency?: string | null }
export interface ClaudeSpendLimitRaw { is_enabled?: boolean | null; monthly_credit_limit?: number | null; used_credits?: number | null; currency?: string | null; out_of_credits?: boolean | null }
export function parseClaudeUsage(
  usage: ClaudeUsageResponse,
  extras?: { prepaid?: ClaudePrepaidRaw | null; spendLimit?: ClaudeSpendLimitRaw | null }
): ClaudeUsageData
export function parseExtraUsage(raw: ClaudeExtraUsageRaw | null | undefined, spendLimit?: ClaudeSpendLimitRaw | null): ClaudeExtraUsage | null
export function parsePrepaid(raw: ClaudePrepaidRaw | null | undefined): MoneyAmount | null
```
Merge rule in `parseExtraUsage`: start from `extra_usage`; any field it lacks is filled from `spendLimit` (`monthly_credit_limit` → limit, `used_credits`, `is_enabled`, `currency`). Return `null` only when both inputs are null/undefined. Cents → `Math.round(x) / 100` (keep two decimals).

- [ ] **Step 1: Write failing tests** in `claude-parse.test.ts`:
  - `parses extra usage in cents`: `extra_usage {is_enabled:true, monthly_limit:5000, used_credits:1720.0, utilization:34.4, currency:"usd"}` → `{enabled:true, currency:"USD", monthlyLimit:50, used:17.2, remaining:32.8, percentage:34.4, level:"safe", outOfCredits:false}`.
  - `derives percentage when utilization is null`: limit 2000, used 1500, utilization null → `percentage: 75`, `level: "moderate"`.
  - `no monthly cap`: `{is_enabled:true, used_credits:277, currency:"CAD"}` → `monthlyLimit:null, remaining:null, percentage:null, used:2.77, currency:"CAD", level:"safe"`.
  - `fills gaps from spend limit and reads out_of_credits`: `extra_usage` undefined + spendLimit `{is_enabled:true, monthly_credit_limit:10000, used_credits:10000, out_of_credits:true}` → `monthlyLimit:100, used:100, remaining:0, percentage:100, outOfCredits:true, level:"critical"`.
  - `returns null with no extra usage data` → `parseExtraUsage(undefined, null) === null`.
  - `parsePrepaid`: `{amount:1234, currency:"usd"}` → `{amount:12.34, currency:"USD"}`; `{amount:-5}` → null; `{amount:NaN}` → null; missing currency → `"USD"`.
  - `keeps a real 0% session over a stale legacy field`: `{five_hour:{utilization:0}, session_usage_percent:0.5}` → `session.percentage === 0` (legacy used only when `five_hour.utilization` is `null`/missing).
  - `parseClaudeUsage` wires `extraUsage` + `prepaidBalance` and still produces `modelBreakdown` from scoped `limits` (one case with `limits:[{percent:40, scope:{model:{display_name:"Fable"}}}]`).
- [ ] **Step 2:** `npx vitest run src/lib/providers/__tests__/claude-parse.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement types + `claude-parse.ts`; switch `claude-client.ts` to it; change the legacy fallback to `!= null` checks; update `windows.test.ts` fixture.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit` → all pass. (tsc will flag every other `ClaudeUsageData` literal — fix them.)
- [ ] **Step 5:** Commit `feat(usage): parse Claude extra usage and prepaid credits`.

### Task 2: OpenAI parser (credits + feature windows)

**Files:**
- Modify: `src/types/index.ts`
- Create: `src/lib/providers/openai-parse.ts` (move `Wham*` interfaces, `PLAN_NAMES`, `windowLabel`, `parseWindow`, and `parseUsageResponse` body here)
- Modify: `src/lib/providers/openai-client.ts` (call `parseOpenAIUsage`)
- Modify: `src/lib/usage/__tests__/windows.test.ts` fixture (`credits: null, creditsDepleted: false`)
- Test: `src/lib/providers/__tests__/openai-parse.test.ts`

**Interfaces — Produces:**
```ts
// src/types/index.ts
export interface OpenAICredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: number | null; // credits; null when absent, non-finite, or <= 0
}
// OpenAIUsageData gains:
  credits: OpenAICredits | null;   // null when wham/usage has no credits object
  creditsDepleted: boolean;        // rate_limit_reached_type ends with "credits_depleted"

// src/lib/providers/openai-parse.ts
export interface WhamUsageResponse { /* existing */ credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string | number | null } | null; rate_limit_reached_type?: string | null }
export interface WhamResetCreditsResponse { /* existing */ }
export function parseOpenAIUsage(usage: WhamUsageResponse, resetCredits: WhamResetCreditsResponse | null): OpenAIUsageData
export function parseCredits(raw: WhamUsageResponse["credits"]): OpenAICredits | null
```
Feature limits: for each `additional_rate_limits` entry push the primary window and, when present, the secondary window. When an entry yields two windows, label each `"<limit_name> · <windowLabel(seconds)>"`; with one window keep the plain `limit_name`.

- [ ] **Step 1: Failing tests:**
  - `parseCredits({has_credits:true, unlimited:false, balance:"9.99"})` → `{hasCredits:true, unlimited:false, balance:9.99}`.
  - balance `"0"`, `""`, `"abc"`, `null`, `"-3"` → `balance: null`, `hasCredits` preserved.
  - `{unlimited:true, has_credits:true}` → `unlimited:true`.
  - `parseCredits(undefined)` and `parseCredits(null)` → `null`.
  - `parseOpenAIUsage` with `rate_limit_reached_type:"workspace_member_credits_depleted"` → `creditsDepleted:true`; with `"primary"` or missing → false.
  - feature limit with primary 18000s + secondary 604800s and `limit_name:"GPT-5 Codex"` → two entries labelled `"GPT-5 Codex · 5-Hour Window"` and `"GPT-5 Codex · 7-Day Window"`; single-window entry keeps label `"GPT-5 Codex"`.
  - existing behaviour kept: windows sorted shortest-first, plan name `"prolite"` → `"Pro Lite"`, only `status:"available"` reset credits listed.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement; switch client.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit` → pass.
- [ ] **Step 5:** Commit `feat(usage): parse Codex credit balance`.

### Task 3: Client fetching — timeouts, OAuth-only Claude, best-effort credit endpoints

**Files:**
- Modify: `src/lib/constants.ts` (add `UPSTREAM_TIMEOUT_MS = 10_000`)
- Modify: `src/lib/providers/claude-client.ts`, `src/lib/providers/openai-client.ts`
- Create: `src/lib/providers/errors.ts`
- Test: `src/lib/providers/__tests__/claude-client.test.ts`, `src/lib/providers/__tests__/openai-client.test.ts` (stub `globalThis.fetch` with `vi.fn`)

**Interfaces — Consumes:** `parseClaudeUsage`, `parseOpenAIUsage` (Tasks 1–2). **Produces:**
```ts
// errors.ts
export class UpstreamAuthError extends Error {}   // 401/403 from any provider
// claude-client.ts
export interface ClaudeSessionCreds { sessionKey: string; organizationId: string }
export class ClaudeClient {
  constructor(session: ClaudeSessionCreds | null);
  static readClaudeCodeOAuthToken(): Promise<string | null>; // now async
  static invalidateTokenCache(): void;
  static markTokenSuspect(): void;
  static fetchOrganizations(sessionKey: string): Promise<Array<{ uuid: string; name: string }>>; // unchanged contract
  fetchUsage(): Promise<ClaudeUsageData>;
}
// openai-client.ts — unchanged public surface; 401/403 throw UpstreamAuthError (keep current message text)
```
Behaviour:
- Every `fetch` passes `signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)`.
- User agents: `process.env.CLAUDE_CODE_USER_AGENT || "claude-code/2.0.32"` for the OAuth call; `process.env.CLAUDE_WEB_USER_AGENT || <current Chrome string>` for claude.ai.
- Keychain: `execFile("security", ["find-generic-password","-s","Claude Code-credentials","-a",username,"-w"], {timeout:3000})` via `util.promisify`; parse `claudeAiOauth.accessToken`; if `claudeAiOauth.expiresAt` (ms epoch) is a number `< Date.now()`, return null. Memo TTL logic unchanged (cache the promise result, not a pending promise per call — concurrent callers may share one in-flight probe).
- `fetchUsage`: usage from OAuth if token, falling back to session on failure; `markTokenSuspect()` only when the OAuth error is `UpstreamAuthError`. If no token and no session → throw `new Error("No Claude credentials: save a claude.ai session key in Settings or sign in to Claude Code.")`. In parallel with usage, when `session` is set: `GET https://claude.ai/api/organizations/{org}/prepaid/credits` and `.../overage_spend_limit` with session headers, each `.catch(() => null)` and non-2xx → null. Pass results as `extras`.
- Session 401/403 throws `UpstreamAuthError` (keep message text).

- [ ] **Step 1: Failing tests** (mock `child_process.execFile` via `vi.mock` so no Keychain access; mock `fetch`):
  - `OAuth-only: no session → no claude.ai calls, prepaidBalance null` (assert no fetched URL contains `claude.ai`).
  - `session creds: prepaid + spend limit merged` (fetch returns usage JSON, `{amount:500,currency:"USD"}`, spend limit JSON) → `prepaidBalance {amount:5, currency:"USD"}`.
  - `prepaid endpoint 500 / throws → usage still resolves with prepaidBalance null`.
  - `session usage 401 → rejects with UpstreamAuthError`.
  - `no token and no session → rejects with "No Claude credentials"`.
  - `every fetch call receives an AbortSignal` (inspect `fetch.mock.calls[i][1].signal`).
  - OpenAI: `401 → UpstreamAuthError`; `reset-credits failure tolerated` (existing behaviour).
  - Keychain: `expired expiresAt → readClaudeCodeOAuthToken resolves null` (call `invalidateTokenCache()` in `beforeEach`; stub `process.platform` to `darwin` with `Object.defineProperty` and restore).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement. Update all call sites of `new ClaudeClient(...)` and `readClaudeCodeOAuthToken()` (`src/app/api/usage/claude/route.ts`, `src/app/api/health/route.ts`, `src/app/api/organizations/claude/route.ts` if used) so the tree compiles — Task 4 rewrites the routes anyway.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit && npm run lint` → pass.
- [ ] **Step 5:** Commit `fix(usage): fetch timeouts, OAuth-only Claude, best-effort credit endpoints`.

### Task 4: Usage service, routes, health, credential memo

**Files:**
- Create: `src/lib/providers/usage-service.ts`
- Modify: `src/app/api/usage/claude/route.ts`, `src/app/api/usage/openai/route.ts`, `src/app/api/health/route.ts`, `src/lib/credentials.ts`, `src/types/index.ts` (`ProviderHealth`)
- Test: `src/app/api/__tests__/usage-routes.test.ts` (mock `@/lib/providers/claude-client` and `@/lib/providers/openai-client` with `vi.mock`; set `LLM_DATA_DIR` to a temp dir like `purge-routes.test.ts`)

**Interfaces — Consumes:** Task 3 clients + `UpstreamAuthError`. **Produces:**
```ts
export type UsageErrorCode = "MISSING_CREDENTIALS" | "AUTH_EXPIRED" | "FETCH_ERROR";
export type UsageResult<T> = { ok: true; data: T } | { ok: false; code: UsageErrorCode; message: string; status: 401 | 502 };
export function getClaudeUsage(opts?: { fresh?: boolean }): Promise<UsageResult<ClaudeUsageData>>;
export function getOpenAIUsage(opts?: { fresh?: boolean }): Promise<UsageResult<OpenAIUsageData>>;
// types: ProviderHealth = { claude: ProviderHealthEntry; openai: ProviderHealthEntry }
export interface ProviderHealthEntry { configured: boolean; connected: boolean; error?: string; code?: UsageErrorCode }
```
- `fresh: true` → `cache.invalidate(key)` before `get`.
- Claude configured = session creds saved OR `await ClaudeClient.readClaudeCodeOAuthToken()` non-null. OpenAI configured = `OpenAIClient.readCodexAuth()` non-null. Not configured → `{ok:false, code:"MISSING_CREDENTIALS", status:401}` (keep existing messages).
- `UpstreamAuthError` → `AUTH_EXPIRED`, 401. Anything else → `FETCH_ERROR`, 502.
- Routes: `GET(request: Request)`, read `new URL(request.url).searchParams.get("fresh") === "1"`; respond `{success:true,data}` or `{success:false,error:{code,message}}` with `status`.
- Health: `configured` = result code !== `MISSING_CREDENTIALS`; `connected` = ok; plus `error`/`code`.
- `credentials.ts`: memoize the decrypted store in a module variable; `saveCredentials` sets it, `deleteCredentials` goes through save; return a structured clone so callers can't mutate the cache.

- [ ] **Step 1: Failing tests:** claude route `?fresh=1` calls the client twice across two requests (no fresh → once); missing creds → 401 `MISSING_CREDENTIALS`; client throws `UpstreamAuthError` → 401 `AUTH_EXPIRED` and health reports `{configured:true, connected:false, code:"AUTH_EXPIRED"}`; generic error → 502 `FETCH_ERROR`; openai happy path returns `credits` from the mocked client. Credentials: `getCredentials()` after `saveCredentials(x)` returns `x` without re-reading (spy on `fs.readFileSync` or just assert equality + mutation isolation).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit && npm run lint` → pass.
- [ ] **Step 5:** Commit `refactor(usage): shared usage service with typed errors and fresh refresh`.

### Task 5: UI — credit sections, strip chip, gating + refresh fixes

**Files:**
- Create: `src/lib/format.ts` (`formatMoney(amount: number, currency: string): string` via `Intl.NumberFormat(undefined,{style:"currency",currency})`, fallback `"${currency} ${amount.toFixed(2)}"` on RangeError; `formatCredits(n: number): string` — integer when whole, else up to 2 decimals, with thousands separators)
- Create: `src/lib/usage/credits.ts` — `claudeCreditSummary(d: ClaudeUsageData): string | null` (prepaid → `"$12.34 left"`; else capped extra usage → `"$32.80 left"`; else uncapped enabled → `"$2.77 spent"`; else null) and `openaiCreditSummary(d: OpenAIUsageData): string | null` (unlimited → `"Unlimited"`; balance → `"240 credits"`; hasCredits → `"Credits available"`; depleted → `"Credits depleted"`; else null)
- Create: `src/components/dashboard/CreditSection.tsx` (shared heading "Add-on credits" + slot; small "depleted/out of credits" red pill prop)
- Modify: `src/components/providers/ClaudeCard.tsx`, `OpenAICard.tsx`, `src/components/dashboard/DashboardGrid.tsx`, `src/components/monitor/ProviderUsageStrip.tsx`, `src/components/dashboard/RefreshControl.tsx`, `src/hooks/use-usage-data.ts`, `src/components/settings/ProviderStatus.tsx`
- Test: `src/lib/usage/__tests__/credits.test.ts`, `src/lib/__tests__/format.test.ts`

**Interfaces — Consumes:** types from Tasks 1–2, `UsageErrorCode`/`ProviderHealthEntry` from Task 4. **Produces:**
```ts
// use-usage-data.ts
export class UsageFetchError extends Error { code?: string }
export function useClaudeUsage(): SWRResponse<ClaudeUsageData, UsageFetchError>   // no enabled arg; always fetches
export function useOpenAIUsage(): SWRResponse<OpenAIUsageData, UsageFetchError>
export async function refreshUsage(): Promise<void> // mutate each usage key with fetcher(`${key}?fresh=1`), plus /api/health; Promise.allSettled
```
UI behaviour:
- Cards drop the `enabled` prop. Show the "not configured" placeholder only when `error?.code === "MISSING_CREDENTIALS"` and there is no data. Otherwise render data (if any) with the error banner. Skeleton only while `isLoading && !data`. SWR: `shouldRetryOnError` false for `MISSING_CREDENTIALS` (use `onErrorRetry`).
- Claude card "Add-on credits" section (only when `extraUsage || prepaidBalance`): prepaid as a `UsageStat` ("Prepaid balance", money); extra usage enabled + cap → `UsageBar` "Extra usage this month" with `used`/`limit` money strings, then `"<remaining> left"`; enabled, no cap → text `"<used> spent this month · no monthly cap"`; disabled → muted "Extra usage is off". `outOfCredits` → red pill "Out of credits".
- OpenAI card section (only when `credits` non-null or `creditsDepleted`): primary line from `openaiCreditSummary`, muted when `!hasCredits`; red pill when `creditsDepleted`. Keep the existing reset-credits block below it.
- Strip: rows call the summary helpers and render the string in a fixed-width right column (`hidden sm:block`, `text-xs`, tabular-nums); strip now uses the ungated hooks (drop `useHealth`).
- `RefreshControl` calls `refreshUsage()`.
- `ProviderStatus`: `connected` → "Connected"; `configured && !connected` → error text in amber; `!configured` → "Not configured".

- [ ] **Step 1: Failing tests:** `formatMoney(12.3,"USD")` contains `"12.30"`; `formatMoney(2.77,"CAD")` contains `"2.77"` and does not throw; `formatMoney(1,"???")` → `"??? 1.00"`; `formatCredits(240)` → `"240"`, `formatCredits(9.99)` → `"9.99"`, `formatCredits(1234.5)` → `"1,234.5"` (use `toLocaleString("en-US", {maximumFractionDigits: 2})`). `claudeCreditSummary` for each branch above; `openaiCreditSummary` for unlimited / balance 240 / hasCredits-no-balance / depleted / null credits.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement helpers, then components.
- [ ] **Step 4:** `npx vitest run && npx tsc --noEmit && npm run lint` → pass.
- [ ] **Step 5:** Commit `feat(ui): show add-on credit balances on dashboard and monitor strip`.

### Task 6: CI, dependency patch, docs

**Files:** `.github/workflows/ci.yml`, `package.json`, `package-lock.json`, `README.md`

- [ ] **Step 1:** CI: after lint add `npx tsc --noEmit`, after `npm test` add `npm run test:edge` and `npm run build`.
- [ ] **Step 2:** `npm install next@16.4.2 eslint-config-next@16.4.2 && npm install -D @types/node@^22`.
- [ ] **Step 3:** Verify: `npx tsc --noEmit && npm run lint && npm test && npm run test:edge && npm run build` → all succeed. If the Next bump breaks build/lint, revert it (keep `@types/node`) and note why.
- [ ] **Step 4:** README: in "What it does"/Dashboard sections describe add-on credits (Claude extra usage + prepaid balance; Codex credits), note prepaid balance needs a claude.ai session key, document `CLAUDE_CODE_USER_AGENT` / `CLAUDE_WEB_USER_AGENT`, `?fresh=1` on `/api/usage/*` in the API reference, update the tests badge count.
- [ ] **Step 5:** Commit `chore: CI typecheck+build, Next 16.4.2, docs for credit tracking`.
