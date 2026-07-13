# Fable 5 Usage in the Claude Card — Fix

**Date:** 2026-07-13
**Status:** Implemented

## Problem

The Claude card showed no Fable 5 usage. `ClaudeClient.parseUsageResponse` built
the per-model breakdown only from the legacy `seven_day_opus` / `seven_day_sonnet`
buckets — verified live to be `null` on current plans, so the breakdown was always
empty and new models (Fable) never appeared.

## API shape (verified 2026-07-13 against both endpoints)

`api.anthropic.com/api/oauth/usage` and `claude.ai/api/organizations/{org}/usage`
return the same modern shape. Per-model usage lives in a `limits[]` array:

```json
"limits": [
  {"kind": "session",       "group": "session", "percent": 61, "scope": null},
  {"kind": "weekly_all",    "group": "weekly",  "percent": 13, "scope": null},
  {"kind": "weekly_scoped", "group": "weekly",  "percent": 15,
   "scope": {"model": {"id": null, "display_name": "Fable"}}}
]
```

`five_hour` / `seven_day` top-level buckets still exist and match the
session/weekly_all entries, so the main bars keep their existing source.

## Fix

`parseUsageResponse` now builds the model breakdown from `limits[]` entries that
carry `scope.model.display_name` (generic — any scoped model appears, not just
Fable), falling back to the legacy buckets only when no scoped entries exist.
One parser serves both runtimes: Electron (OAuth/Keychain path) and the Docker
container (session-key path).

Also present in the response but intentionally not surfaced yet: `extra_usage` /
`spend` (usage-credit balance, e.g. 24% of $40 used). Candidate for a future
billing row on the card.
