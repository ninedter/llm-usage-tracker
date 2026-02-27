export type ProviderId = "claude";

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
}

// --- Agent Monitor ---

export type AgentStatus = "idle" | "working" | "completed" | "failed" | "cancelled";
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
