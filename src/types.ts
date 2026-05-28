export type WorkflowStatus = "planning" | "running" | "paused" | "completed" | "failed" | "aborted"

export type PhaseStatus = "pending" | "running" | "completed" | "failed" | "skipped"

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "skipped"

export type ModelRole = "planner" | "worker" | "verifier" | "synthesizer" | "critic" | "scout"

export interface ModelRouterConfig {
  default?: string
  planner?: string
  worker?: string
  verifier?: string
  synthesizer?: string
  critic?: string
  scout?: string
  [role: string]: string | undefined
}

export interface DynamicWorkflowOptions {
  objective: string
  cwd: string
  baseUrl?: string
  workflowId?: string
  startServer?: boolean
  maxAgents: number
  concurrency: number
  verificationRounds: number
  retryLimit: number
  qualityGateTimeoutMs: number
  cleanUpSessions: boolean
  dryRun: boolean
  failFast: boolean
  maxSummaryInputChars: number
  models: ModelRouterConfig
  metadata?: Record<string, unknown>
}

export interface WorkflowPlan {
  title: string
  summary: string
  maxAgentEstimate: number
  phases: WorkflowPhase[]
}

export interface WorkflowPhase {
  id: string
  title: string
  description: string
  strategy: string
  dependsOn: string[]
  tasks: AgentTask[]
  qualityGates: string[]
  verification: PhaseVerification
}

export interface PhaseVerification {
  strategy: string
  sampleSize?: number
}

export interface AgentTask {
  id: string
  title: string
  prompt: string
  role: ModelRole
  model?: string
  targetFiles: string[]
  acceptanceCriteria: string[]
  expectedArtifacts: string[]
  canEdit: boolean
  dependsOn: string[]
}

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
  followUpPrompt?: string
  rawText: string
}

export interface TaskAttempt {
  attempt: number
  sessionId?: string
  model?: string
  startedAt: string
  completedAt?: string
  output?: string
  error?: string
  verification?: VerificationResult
}

export interface TaskRunState {
  taskId: string
  phaseId: string
  status: TaskStatus
  attempts: TaskAttempt[]
  output?: string
  verified: boolean
  verification?: VerificationResult
  updatedAt: string
}

export interface PhaseRunState {
  phaseId: string
  status: PhaseStatus
  startedAt?: string
  completedAt?: string
  gateResults: ShellResult[]
  error?: string
}

export interface WorkflowEvent {
  time: string
  type: string
  message: string
  details?: Record<string, unknown>
}

export interface StoredWorkflowOptions {
  maxAgents: number
  concurrency: number
  verificationRounds: number
  retryLimit: number
  qualityGateTimeoutMs: number
  cleanUpSessions: boolean
  failFast: boolean
  maxSummaryInputChars: number
  models: ModelRouterConfig
  metadata?: Record<string, unknown>
}

export interface WorkflowState {
  id: string
  objective: string
  cwd: string
  status: WorkflowStatus
  createdAt: string
  updatedAt: string
  options: StoredWorkflowOptions
  plan?: WorkflowPlan
  phases: Record<string, PhaseRunState>
  tasks: Record<string, TaskRunState>
  sessions: string[]
  summary?: string
  summaryPath?: string
  error?: string
}

export interface WorkflowClient {
  health(): Promise<unknown>
  providers(): Promise<unknown>
  createSession(title: string, parent?: string): Promise<string>
  initSession(sessionId: string): Promise<void>
  prompt(sessionId: string, text: string, options?: ClientPromptOptions): Promise<PromptResult>
  shell(sessionId: string, command: string, timeoutMs?: number): Promise<ShellResult>
  deleteSession(sessionId: string): Promise<void>
  abortSession(sessionId: string): Promise<void>
  log(level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>): Promise<void>
  close?(): Promise<void>
}

export interface ClientPromptOptions {
  model?: string
  agent?: string
  noReply?: boolean
  format?: JsonSchemaFormat
}

export interface JsonSchemaFormat {
  type: "json_schema"
  schema: Record<string, unknown>
  retryCount?: number
}

export interface Reporter {
  info(message: string, details?: Record<string, unknown>): void
  warn(message: string, details?: Record<string, unknown>): void
  error(message: string, details?: Record<string, unknown>): void
}
