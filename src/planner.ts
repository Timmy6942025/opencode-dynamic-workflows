import type { DynamicWorkflowOptions, WorkflowClient, WorkflowPlan } from "./types.js"
import { resolveModel } from "./model-router.js"
import { jsonSchema, splitModelId } from "./util.js"

// ---------------------------------------------------------------------------
// Planner schema — the LLM returns a structured plan containing a script
// ---------------------------------------------------------------------------

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short workflow title." },
    summary: { type: "string", description: "Brief explanation of the orchestration strategy." },
    maxAgentEstimate: { type: "number", description: "Estimated number of agents that will be spawned." },
    script: {
      type: "string",
      description:
        "A JavaScript workflow script that orchestrates the task. " +
        "The script is executed inside an async function with the workflow API injected as globals. " +
        "Use spawn/wait/parallel/forEach/synthesize/adversarial/tournament/loop/shell/log/ask/truncate. " +
        "The script should return a string: the final output of the workflow.",
    },
  },
  required: ["title", "summary", "maxAgentEstimate", "script"],
}

// ---------------------------------------------------------------------------
// createDynamicPlan — ask the LLM to write a workflow script
// ---------------------------------------------------------------------------

export async function createDynamicPlan(client: WorkflowClient, options: DynamicWorkflowOptions): Promise<WorkflowPlan> {
  const sessionId = await client.createSession("dynamic-workflow-planner")
  const model = resolveModel("planner", undefined, options.models)
  const prompt = buildPlannerPrompt(options)

  const result = await client.prompt(sessionId, prompt, {
    model: splitModelId(model),
    agent: "plan",
    format: jsonSchema(PLAN_SCHEMA, 3),
  })

  if (options.cleanUpSessions) await client.deleteSession(sessionId)

  const plan = normalizePlan(result.structured, options)
  if (!plan.script) {
    return fallbackPlan(options)
  }

  plan.estimatedTokens = estimatePlanTokens(plan)
  plan.estimatedCost = estimateCost(plan.estimatedTokens, model)

  return plan
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildPlannerPrompt(options: DynamicWorkflowOptions): string {
  const lines: string[] = [
    "You are a workflow script generator for OpenCode dynamic workflows.",
    "",
    "Your job is to write a JavaScript workflow script — a custom harness tailor-made for the task.",
    "The script runs inside an async function with the workflow API available as globals.",
    "",
    "AVAILABLE API (already injected as globals — do NOT import anything):",
    "",
    "  spawn(label, prompt, {model?, role?}) → SpawnedAgent",
    "    Spawn a subagent. Returns immediately. Call wait() to block until done.",
    "",
    "  wait(agent | agent[]) → AgentResult[]",
    "    Block until one or more agents finish. Always returns an array.",
    "    AgentResult = { text: string, error?: string, tokensUsed: number, model?: string }",
    "",
    "  parallel([{label, prompt, model?, role?}]) → AgentResult[]",
    "    Spawn several agents and wait for all of them.",
    "",
    "  forEach(items, fn) → AgentResult[]",
    "    Fan-out over an array. fn(item, index) => {label, prompt, model?, role?}",
    "",
    "  map(items, fn) → [{item, result: AgentResult}]",
    "    Like forEach but preserves the mapping so you can correlate results.",
    "",
    "  synthesize({agents, prompt?, model?}) → AgentResult",
    "    Combine multiple agent outputs into one coherent result.",
    "",
    "  adversarial({worker, verifierPrompt?, verifierModel?, rubric?}) → {worker: AgentResult, verification: VerificationResult}",
    "    Verify a worker's output against criteria. worker is a SpawnedAgent.",
    "",
    "  tournament({agents, judge(a, b) → boolean}) → AgentResult",
    "    Bracket-style competition. judge receives two AgentResults and returns the winning SpawnedAgent.",
    "",
    "  loop(fn, until, maxIterations?) → AgentResult[]",
    "    Keep spawning agents until a condition is met.",
    "    fn(iteration, previous?) => {label, prompt, model?, role?}",
    "    until(result, iteration) => boolean",
    "",
    "  shell(command, timeoutMs?) → {command, exitCode, stdout, stderr}",
    "    Run a shell command in the working directory.",
    "",
    "  ask(question) → string",
    "    Ask the user a question (returns the question as placeholder).",
    "",
    "  log(level, message)",
    "    Log a message. level: 'info' | 'warn' | 'error'",
    "",
    "  truncate(text, maxChars) → string",
    "    Truncate text to maxChars.",
    "",
    "CONSTANTS AVAILABLE: objective, stoppingCondition, maxAgents, concurrency, cwd, tokenBudget, skills",
    "STANDARD LIBS AVAILABLE: JSON, Math, Array, Object, String, Number, Date, RegExp, Map, Set, Promise",
    "",
    "SCRIPT RULES:",
    "- The script must be valid JavaScript (async is fine — it runs inside an async wrapper).",
    "- Do NOT use import/require. All API functions are pre-injected globals.",
    "- Return a string from the script (the final output of the workflow).",
    "- Use try/catch for error handling where appropriate.",
    "- Prefer parallelism when tasks are independent.",
    "- Use the 'role' parameter to route agents: 'worker' (code), 'scout' (explore/read), 'critic' (challenge), 'synthesizer' (combine), 'verifier' (check).",
    "- For large tasks, use forEach/map with batching to respect the concurrency limit.",
    "- Use adversarial verification when quality matters.",
    "- Use tournament for subjective quality comparisons.",
    "- Use loop when the amount of work is unknown.",
    "",
    "PATTERNS YOU CAN USE:",
    "",
    "  // Fan-out and synthesize",
    "  const results = await parallel([{label: 'A', prompt: '...'}, {label: 'B', prompt: '...'}])",
    "  const final = await synthesize({agents: [/* spawned agents */], prompt: 'Combine these findings'})",
    "",
    "  // Adversarial verification",
    "  const worker = spawn('Implement X', '...')",
    "  const {verification} = await adversarial({worker, rubric: ['Works correctly', 'Edge cases handled']})",
    "",
    "  // Tournament",
    "  const ideas = await parallel([{label: 'Idea 1', prompt: '...'}, ...])",
    "  const agents = ideas.map((_, i) => spawn(`Idea ${i+1}`, '...'))",
    "  const best = await tournament({agents, judge: (a, b) => a.text.length > b.text.length})",
    "",
    "  // Loop until done",
    "  const results = await loop(",
    "    (i, prev) => ({label: `Fix ${i}`, prompt: prev ? `Previous: ${prev.text}. Fix remaining issues.` : 'Start fixing'}),",
    "    (result) => result.text.includes('ALL TESTS PASS'),",
    "    10",
    "  )",
    "",
    `Objective: ${options.objective}`,
  ]

  if (options.stoppingCondition) {
    lines.push(`Stopping condition: ${options.stoppingCondition}`)
  }

  lines.push(
    `Working directory: ${options.cwd}`,
    `Max agents: ${options.maxAgents}`,
    `Concurrency: ${options.concurrency}`,
    `Adversarial review: ${options.adversarialReview ? "enabled" : "disabled"}`,
  )

  if (options.skills.length > 0) {
    lines.push(`Skills/constraints: ${options.skills.join(", ")}`)
  }

  if (options.tokenBudget) {
    lines.push(`Token budget: ${options.tokenBudget}`)
  }

  lines.push(
    "",
    "Return the structured plan with the workflow script. The script should be complete and self-contained.",
  )

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizePlan(value: unknown, options: DynamicWorkflowOptions): WorkflowPlan {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const script = typeof input.script === "string" ? input.script : ""

  return {
    title: String(input.title || "Dynamic workflow"),
    summary: String(input.summary || ""),
    maxAgentEstimate: Number(input.maxAgentEstimate) || 4,
    script,
    requiresApproval: false,
  }
}

function fallbackPlan(options: DynamicWorkflowOptions): WorkflowPlan {
  const script = `// Fallback workflow — simple sequential execution
log("info", "Starting fallback workflow: " + objective)

// Step 1: Survey the codebase
const [survey] = await wait(spawn("Survey", [
  "Survey the repository for this objective.",
  "Return concrete file paths, risks, and recommended approach.",
  "",
  "Objective: " + objective,
  "Working directory: " + cwd,
].join("\\n"), { role: "scout" }))

log("info", "Survey complete")

// Step 2: Execute the work
const [result] = await wait(spawn("Execute", [
  "Complete this objective with verifiable evidence.",
  "",
  "Survey findings:",
  truncate(survey.text, 8000),
  "",
  "Objective: " + objective,
].join("\\n"), { role: "worker" }))

log("info", "Execution complete")

// Step 3: Verify
const worker = spawn("Verify", result.text)
const {verification} = await adversarial({
  worker,
  rubric: ["Addresses the objective", "Evidence provided"],
})

if (!verification.pass) {
  log("warn", "Verification found issues: " + verification.issues.join("; "))
}

return result.text`

  return {
    title: "Dynamic workflow",
    summary: "Fallback plan — sequential survey → execute → verify.",
    maxAgentEstimate: 4,
    script,
    requiresApproval: false,
  }
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

function estimatePlanTokens(plan: WorkflowPlan): number {
  return Math.max(2000, plan.maxAgentEstimate * 2500)
}

function estimateCost(tokens: number, model?: string): number | undefined {
  if (!model) return undefined
  const rates: Record<string, number> = {
    "openai/gpt-5.1-codex": 3.0,
    "anthropic/claude-sonnet-4-5": 3.0,
    "anthropic/claude-opus-4-8": 15.0,
    "google/gemini-3-pro": 1.5,
  }
  const rate = rates[model] ?? 3.0
  return Math.round((tokens / 1_000_000) * rate * 100) / 100
}
