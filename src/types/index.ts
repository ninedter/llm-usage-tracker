export type ProviderId = "claude" | "openai";

export type UsageLevel = "safe" | "moderate" | "critical";

// --- Credentials ---

export interface ClaudeCredentials {
  sessionKey?: string;
  organizationId?: string;
}

export interface CredentialStore {
  claude?: ClaudeCredentials;
}

// --- Usage Data ---

export interface UsageWindow {
  tokensUsed: number;
  tokenLimit: number;
  percentage: number;
  resetTime: string | null;
  level: UsageLevel;
}

export interface ModelUsage {
  modelId: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost?: number;
  requestCount?: number;
  utilization?: number; // 0-100, from per-model usage buckets
  level?: UsageLevel;
}

export interface BillingInfo {
  currentSpend: number;
  creditLimit: number;
  creditRemaining: number;
  currency: string;
  resetDate: string | null;
}

// --- Provider-specific Usage ---

export interface ClaudeUsageData {
  session: UsageWindow;
  weekly: UsageWindow;
  modelBreakdown: ModelUsage[];
  billing?: BillingInfo;
  lastUpdated: string;
}

// Rate-limit windows vary by plan (some have only a weekly window,
// Plus/Pro also have a 5-hour window), so they're a list rather than
// fixed session/weekly fields.
export interface OpenAIRateWindow {
  label: string;
  windowSeconds: number;
  percentage: number;
  resetTime: string | null;
  level: UsageLevel;
}

// A granted rate-limit reset credit (spent to clear a hit limit early)
export interface OpenAIResetCredit {
  id: string;
  title: string;
  expiresAt: string | null;
}

export interface OpenAIUsageData {
  planType: string;
  windows: OpenAIRateWindow[];
  featureLimits: OpenAIRateWindow[];
  // Rate-limit reset credits (null when the plan doesn't expose them)
  resetCreditsAvailable: number | null;
  resetCredits: OpenAIResetCredit[];
  lastUpdated: string;
}

// --- API Responses ---

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface ProviderHealth {
  claude: { connected: boolean; error?: string };
  openai: { connected: boolean; error?: string };
}

// --- Agent Monitor ---

export type AgentStatus = "idle" | "working" | "completed" | "failed" | "cancelled" | "archived";
export type AgentEventType =
  | "tool_call"
  | "tool_result"
  | "content"
  | "status_change"
  | "error"
  | "session_start"
  | "session_end"
  | "stop"
  | "notification"
  | "subagent_start"
  | "subagent_stop"
  | "compaction";

export interface SessionRecord {
  id: string;
  status: "active" | "completed" | "error" | "abandoned";
  project: string;
  cwd: string;
  entrypoint: string;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
  metadata: string | null; // JSON string
}

export interface AgentRecord {
  id: string;
  session_id: string;
  parent_agent_id: string | null;
  type: string; // "main" | "subagent" | agent subtype
  subagent_type: string | null; // e.g. "Explore", "code-reviewer", etc.
  description: string;
  status: AgentStatus;
  current_tool: string | null;
  started_at: number;
  ended_at: number | null;
  metadata: string | null; // JSON string
  created_at: number;
}

export interface AgentEvent {
  id: number;
  agent_id: string;
  session_id: string;
  event_type: AgentEventType;
  tool_name: string | null;
  summary: string | null;
  content: string | null;
  files_affected: string | null; // JSON array string
  timestamp: number;
  created_at: number;
}

export interface TokenUsage {
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  updated_at: number;
}

export interface AgentSession {
  session_id: string;
  status: string;
  project: string;
  entrypoint: string;
  agent_count: number;
  working_count: number;
  subagent_count: number;
  event_count: number;
  total_cost: number;
  first_started: number;
  last_activity: number;
}

export interface AgentWithEvents extends AgentRecord {
  events: AgentEvent[];
  children?: AgentRecord[];
}

export interface MonitorStats {
  total_sessions: number;
  active_sessions: number;
  total_agents: number;
  working_agents: number;
  total_events: number;
  events_today: number;
  total_cost: number;
}

// --- Analytics ---

export interface AnalyticsOverview {
  total_cost: number;
  cost_change_pct: number;
  session_count: number;
  avg_session_duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  top_model: string;
  top_model_cost_pct: number;
  tool_call_count: number;
  tool_success_rate: number;
}

export interface TrendPoint {
  date: string;
  cost: number;
  tokens: number;
  events: number;
  sessions: number;
}

export interface SessionAnalyticRow {
  session_id: string;
  project: string;
  entrypoint: string;
  status: string;
  duration_ms: number;
  total_tokens: number;
  cost: number;
  tool_count: number;
  started_at: number;
}

export interface ToolAnalyticEntry {
  tool_name: string;
  call_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_duration_ms: number;
}

export interface ToolTimelinePoint {
  tool_name: string;
  timestamp: number;
  success: boolean;
  duration_ms: number;
}

export interface ToolAnalytics {
  tools: ToolAnalyticEntry[];
  timeline: ToolTimelinePoint[];
}

export interface FileEntry {
  file_path: string;
  directory: string;
  file_name: string;
  modification_count: number;
  tools_used: string[];
  tool_breakdown: Record<string, number>;
}

export interface FileAnalytics {
  files: FileEntry[];
  directories: { directory: string; total_modifications: number }[];
}

export interface ModelEntry {
  model: string;
  cost: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface ModelTrendPoint {
  date: string;
  model: string;
  cost: number;
  tokens: number;
}

export interface ModelAnalytics {
  models: ModelEntry[];
  trend: ModelTrendPoint[];
}

export interface HeatmapCell {
  dow: number; // 0 = Sunday … 6 = Saturday (SQLite %w)
  hour: number; // 0-23 local time
  events: number;
}

export interface ProjectUsage {
  project: string;
  sessions: number;
  events: number;
  tool_calls: number;
  active_days: number;
  last_active: number;
}

export interface UsageInsightStats {
  active_days: number;
  total_days: number;
  current_streak: number;
  busiest_day: { date: string; events: number } | null;
  peak_hour: { hour: number; events: number } | null;
  longest_session_ms: number;
  avg_events_per_session: number;
  explore_calls: number;
  modify_calls: number;
  top_tool: string | null;
}

export interface UsageInsights {
  heatmap: HeatmapCell[];
  projects: ProjectUsage[];
  stats: UsageInsightStats;
}

// --- Data Management / Purge ---

export interface StorageInfo {
  db_bytes: number;
  wal_bytes: number;
  counts: {
    sessions: number;
    agents: number;
    agent_events: number;
    token_usage: number;
    daily_usage: number;
  };
  oldest_ms: number | null;
  newest_ms: number | null;
}

export interface PurgeCounts {
  sessions: number;
  agents: number;
  events: number;
  token_usage: number;
}

export interface PurgeResult {
  deleted: PurgeCounts;
  bytes_freed: number;
  daily_usage_cleared?: number; // set only by a full "Everything" wipe
}

export interface RetentionPolicy {
  enabled: boolean;
  days: number;
  last_purge_at: number | null;
}
