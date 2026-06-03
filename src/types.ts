export type WorkflowStatus = "planning" | "plan_approval" | "running" | "paused" | "completed" | "failed" | "aborted"

export type ModelRole = "planner" | "worker" | "verifier" | "synthesizer" | "critic" | "scout" | "adversary"

export type EffortLevel = "low" | "medium" | "high" | "ultra"

// ---------------------------------------------------------------------------
// Agent types (used by the runtime)
// ---------------------------------------------------------------------------

export interface AgentResult {
  text: string
  error?: string
  tokensUsed: number
  model?: string
}

export interface SpawnedAgent {
  id: string
  label: string
  result: Promise<AgentResult>
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

export interface ModelRouterConfig {
  default?: string
  planner?: string
  worker?: string
  verifier?: string | string[]
  synthesizer?: string
  critic?: string
  scout?: string
  [role: string]: string | string[] | undefined
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DynamicWorkflowOptions {
  objective: string
  stoppingCondition?: string
  cwd: string
  workflowId?: string
  maxAgents: number
  concurrency: number
  cleanUpSessions: boolean
  dryRun: boolean
  models: ModelRouterConfig
  metadata?: Record<string, unknown>
  effortLevel: EffortLevel
  requireApproval: boolean
  adversarialReview: boolean
  saveWorkflow: boolean
  workflowName?: string
  useWorktree: boolean
  worktreeName?: string
  skills: string[]
  template?: string
  consensusModels?: string[]
  tokenBudget?: number
  signal?: AbortSignal
  /** Progress callback from ToolContext.metadata() for live UI updates. */
  onProgress?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
}

// ---------------------------------------------------------------------------
// Plan — now just the script + metadata
// ---------------------------------------------------------------------------

export interface WorkflowPlan {
  title: string
  summary: string
  maxAgentEstimate: number
  /** The dynamically generated JavaScript workflow script. */
  script: string
  estimatedTokens?: number
  estimatedCost?: number
  requiresApproval: boolean
}

// ---------------------------------------------------------------------------
// Client interface — aligns with OpenCode SDK's session API
// ---------------------------------------------------------------------------

export interface WorkflowClient {
  createSession(title: string, parent?: string): Promise<string>
  prompt(sessionId: string, text: string, options?: ClientPromptOptions): Promise<PromptResult>
  /** Fire-and-forget: send a prompt and return immediately. OpenCode handles lifecycle. */
  promptAsync(sessionId: string, text: string, options?: ClientPromptOptions): Promise<void>
  /** Poll for messages in a session — used to retrieve async prompt results. */
  messages(sessionId: string): Promise<unknown>
  shell(sessionId: string, command: string, timeoutMs?: number): Promise<ShellResult>
  deleteSession(sessionId: string): Promise<void>
  abortSession(sessionId: string): Promise<void>
  log(level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>): Promise<void>
}

export interface ClientPromptOptions {
  /** Model override using SDK's { providerID, modelID } format. */
  model?: { providerID: string; modelID: string }
  agent?: string
  noReply?: boolean
  format?: JsonSchemaFormat
}

export interface JsonSchemaFormat {
  type: "json_schema"
  schema: Record<string, unknown>
  retryCount?: number
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface PromptResult {
  text: string
  structured?: unknown
  raw?: unknown
  error?: Error
}

export interface ShellResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  raw?: unknown
}

export interface VerificationResult {
  pass: boolean
  confidence: number
  issues: string[]
  evidence: string[]
  rawText: string
  tokensUsed?: number
  model?: string
}

// ---------------------------------------------------------------------------
// State — file-backed, resumable
// ---------------------------------------------------------------------------

export interface WorkflowState {
  id: string
  objective: string
  stoppingCondition?: string
  cwd: string
  status: WorkflowStatus
  createdAt: string
  updatedAt: string
  options: StoredWorkflowOptions
  plan?: WorkflowPlan
  /** The generated workflow script (for resumability). */
  script?: string
  /** Output returned by the script. */
  scriptOutput?: string
  /** Agent session ids created during execution. */
  sessions: string[]
  summary?: string
  summaryPath?: string
  error?: string
  totalTokensUsed: number
  worktreePath?: string
  isTemplate: boolean
  templateName?: string
  /** Log of all spawned agents and their results. */
  agentLog: AgentLogEntry[]
}

export interface AgentLogEntry {
  id: string
  label: string
  model?: string
  status: "running" | "completed" | "failed"
  output?: string
  error?: string
  tokensUsed: number
  startedAt: string
  completedAt?: string
}

export interface StoredWorkflowOptions {
  maxAgents: number
  concurrency: number
  cleanUpSessions: boolean
  models: ModelRouterConfig
  metadata?: Record<string, unknown>
  effortLevel: EffortLevel
  requireApproval: boolean
  adversarialReview: boolean
  saveWorkflow: boolean
  workflowName?: string
  useWorktree: boolean
  worktreeName?: string
  skills: string[]
  template?: string
  consensusModels?: string[]
  tokenBudget?: number
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface WorkflowTemplate {
  id: string
  name: string
  description: string
  category: string
  objectivePattern: string
  defaultOptions: Partial<DynamicWorkflowOptions>
  /** A function that returns a JavaScript workflow script tailored to the objective. */
  scriptTemplate: (objective: string, options: DynamicWorkflowOptions) => string
  skills: string[]
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface WorkflowEvent {
  time: string
  type: string
  message: string
  details?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface Reporter {
  info(message: string, details?: Record<string, unknown>): void
  warn(message: string, details?: Record<string, unknown>): void
  error(message: string, details?: Record<string, unknown>): void
}
