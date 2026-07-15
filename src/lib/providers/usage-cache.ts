import { ttlCache } from "@/lib/ttl-cache";
import type { ClaudeUsageData, OpenAIUsageData } from "@/types";

// 30s: /api/health and a dashboard refresh share one upstream call; the 60s
// usage poll always refetches.
export const claudeUsageCache = ttlCache<ClaudeUsageData>(30_000);
export const openaiUsageCache = ttlCache<OpenAIUsageData>(30_000);
