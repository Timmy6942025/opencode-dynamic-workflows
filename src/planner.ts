import type { AgentTask, DynamicWorkflowOptions, ModelRole, WorkflowClient, WorkflowPhase, WorkflowPlan } from "./types.js"
import { resolveModel } from "./model-router.js"
import { coerceStringArray, jsonSchema, slugify, stableId } from "./util.js"

const SCOUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    filePaths: { type: "array", items: { type: "string" }, description: "Concrete file paths relevant to the objective." },
    dependencyGraph: {
      type: "object",
      additionalProperties: { type: "array", items: { type: "string" } },
      description: "Map of file paths to their direct dependencies.",
    },
    testLocations: { type: "array", items: { type: "string" }, description: "Paths to test files that cover relevant code." },
    complexityEstimate: {
      type: "string",
      enum: ["low", "medium", "high", "ultra"],
      description: "Estimated complexity of the objective.",
    },
    summary: { type: "string", description: "Concise summary of codebase state relevant to the objective." },
    risks: { type: "array", items: { type: "string" }, description: "Potential risks or blockers." },
    recommendedPhases: { type: "array", items: { type: "string" }, description: "Suggested phase breakdown." },
  },
  required: ["filePaths", "complexityEstimate", "summary", "risks", "recommendedPhases"],
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short workflow title." },
    summary: { type: "string", description: "Brief explanation of the orchestration strategy." },
    maxAgentEstimate: { type: "number", description: "Estimated number of worker or verifier agents needed." },
    phases: {
      type: "array",
      description: "Ordered workflow phases. Dependencies can reference previous phase ids.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          strategy: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          qualityGates: {
            type: "array",
            description: "Shell commands to run after the phase if useful and safe.",
            items: { type: "string" },
          },
          verification: {
            type: "object",
            additionalProperties: false,
            properties: {
              strategy: { type: "string" },
              sampleSize: { type: "number" },
            },
            required: ["strategy"],
          },
          tasks: {
            type: "array",
            description: "Independent tasks for OpenCode worker sessions.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                prompt: { type: "string" },
                role: {
                  type: "string",
                  enum: ["worker", "scout", "critic"],
                  description: "Model routing role for this task.",
                },
                model: { type: "string", description: "Optional OpenCode provider/model override." },
                targetFiles: { type: "array", items: { type: "string" } },
                acceptanceCriteria: { type: "array", items: { type: "string" } },
                expectedArtifacts: { type: "array", items: { type: "string" } },
                canEdit: { type: "boolean" },
                dependsOn: { type: "array", items: { type: "string" } },
              },
              required: ["id", "title", "prompt", "role", "acceptanceCriteria", "canEdit"],
            },
          },
        },
        required: ["id", "title", "description", "strategy", "dependsOn", "qualityGates", "verification", "tasks"],
      },
    },
  },
  required: ["title", "summary", "maxAgentEstimate", "phases"],
}

export async function createDynamicPlan(client: WorkflowClient, options: DynamicWorkflowOptions): Promise<WorkflowPlan> {
  // If a template provided a planTemplate, use it directly
  const planTemplate = options.metadata?.planTemplate as WorkflowPlan | undefined
  if (planTemplate) {
    return planTemplate
  }

  // Scout-first planning: run scout agents to map codebase before planning
  let scoutFindings: import("./types.js").ScoutFindings | undefined
  if (options.scoutFirst || options.effortLevel === "high" || options.effortLevel === "ultra") {
    try {
      scoutFindings = await runScoutPhase(client, options)
    } catch {
      // Scout failure is non-fatal; planner will proceed without findings
    }
  }

  const sessionId = await client.createSession("dynamic-workflow-planner")
  await client.initSession(sessionId)
  const model = resolveModel("planner", undefined, options.models)
  const promptText = scoutFindings
    ? `${buildPlannerPrompt(options)}\n\n--- Scout Findings ---\n${formatScoutFindings(scoutFindings)}`
    : buildPlannerPrompt(options)
  const result = await client.prompt(sessionId, promptText, {
    model,
    agent: "plan",
    format: jsonSchema(PLAN_SCHEMA, 3),
  })
  const plan = normalizePlan(result.structured, options)
  if (plan.phases.length === 0) {
    return fallbackPlan(options)
  }

  // Add token/cost estimates
  const estimatedTokens = estimatePlanTokens(plan)
  plan.estimatedTokens = estimatedTokens
  plan.estimatedCost = estimateCost(estimatedTokens, model)

  // Generate orchestration script if requested
  if (options.generateOrchestrationScript && options.orchestrationMode === "dynamic") {
    plan.orchestrationScript = generateOrchestrationScript(plan, options)
  }

  return plan
}

export function buildPlannerPrompt(options: DynamicWorkflowOptions): string {
  const lines = [
    "You are planning an OpenCode dynamic workflow.",
    "",
    "OpenCode sessions are the subagent primitive. The coordinator will spawn isolated sessions, inject task context, run prompts, run verifier sessions, execute quality gates, checkpoint results, and synthesize the final answer.",
    "",
    "Plan requirements:",
    "- Decompose the objective into ordered phases with explicit dependencies.",
    "- Fan out independent tasks when it improves coverage, but do not create busywork.",
    "- Keep tasks scoped enough that each worker has a clean context window.",
    "- Workers may read, edit, and run commands through OpenCode according to canEdit.",
    "- The workflow script/coordinator itself should not directly mutate the repo; agents do codebase work.",
    "- Include independent verification or adversarial review for findings and implementation work.",
    "- Include safe quality gate shell commands only when they are likely to exist in this repository.",
    "- Use model routing roles, not vendor-specific assumptions. Valid task roles are worker, scout, and critic.",
    "- Never exceed the max agent budget.",
    "",
    `Objective: ${options.objective}`,
  ]

  if (options.stoppingCondition) {
    lines.push(`Stopping condition: ${options.stoppingCondition}`)
  }

  lines.push(
    `Working directory: ${options.cwd}`,
    `Max total worker tasks: ${options.maxAgents}`,
    `Max concurrent sessions: ${options.concurrency}`,
    `Verification rounds requested: ${options.verificationRounds}`,
    `Adversarial review: ${options.adversarialReview ? "enabled" : "disabled"}`,
    `Orchestration mode: ${options.orchestrationMode}`,
  )

  if (options.skills.length > 0) {
    lines.push(`Skills/constraints: ${options.skills.join(", ")}`)
  }

  if (options.tokenBudget) {
    lines.push(`Token budget: ${options.tokenBudget}`)
  }

  lines.push(
    "",
    "Return only the structured plan matching the schema.",
  )

  return lines.join("\n")
}

export function normalizePlan(value: unknown, options: DynamicWorkflowOptions): WorkflowPlan {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const phasesInput = Array.isArray(input.phases) ? input.phases : []
  const phases: WorkflowPhase[] = []
  let taskCount = 0

  for (const [phaseIndex, rawPhase] of phasesInput.entries()) {
    if (!rawPhase || typeof rawPhase !== "object") continue
    const phaseRecord = rawPhase as Record<string, unknown>
    const phaseId = cleanId(String(phaseRecord.id || phaseRecord.title || `phase-${phaseIndex + 1}`), `phase-${phaseIndex + 1}`)
    const rawTasks = Array.isArray(phaseRecord.tasks) ? phaseRecord.tasks : []
    const tasks: AgentTask[] = []

    for (const [taskIndex, rawTask] of rawTasks.entries()) {
      if (taskCount >= options.maxAgents) break
      if (!rawTask || typeof rawTask !== "object") continue
      const taskRecord = rawTask as Record<string, unknown>
      const title = String(taskRecord.title || `Task ${taskIndex + 1}`)
      const prompt = String(taskRecord.prompt || title)
      const idBase = String(taskRecord.id || stableId("task", `${phaseId}:${title}:${prompt}`))
      tasks.push({
        id: cleanId(idBase, `task-${phaseIndex + 1}-${taskIndex + 1}`),
        title,
        prompt,
        role: normalizeTaskRole(taskRecord.role),
        model: typeof taskRecord.model === "string" ? taskRecord.model : undefined,
        targetFiles: coerceStringArray(taskRecord.targetFiles),
        acceptanceCriteria: coerceStringArray(taskRecord.acceptanceCriteria),
        expectedArtifacts: coerceStringArray(taskRecord.expectedArtifacts),
        canEdit: Boolean(taskRecord.canEdit),
        dependsOn: coerceStringArray(taskRecord.dependsOn),
      })
      taskCount++
    }

    phases.push({
      id: phaseId,
      title: String(phaseRecord.title || phaseId),
      description: String(phaseRecord.description || ""),
      strategy: String(phaseRecord.strategy || ""),
      dependsOn: coerceStringArray(phaseRecord.dependsOn),
      qualityGates: coerceStringArray(phaseRecord.qualityGates),
      verification: normalizeVerification(phaseRecord.verification),
      tasks,
    })
  }

  return {
    title: String(input.title || "Dynamic workflow"),
    summary: String(input.summary || ""),
    maxAgentEstimate: Number(input.maxAgentEstimate || taskCount),
    phases,
    requiresApproval: false,
  }
}

function normalizeVerification(value: unknown): { strategy: string; sampleSize?: number } {
  if (!value || typeof value !== "object") return { strategy: "Verify task outputs against acceptance criteria." }
  const record = value as Record<string, unknown>
  const sampleSize = Number(record.sampleSize)
  return {
    strategy: String(record.strategy || "Verify task outputs against acceptance criteria."),
    sampleSize: Number.isFinite(sampleSize) && sampleSize > 0 ? sampleSize : undefined,
  }
}

function normalizeTaskRole(value: unknown): ModelRole {
  if (value === "scout" || value === "critic" || value === "adversary") return value
  return "worker"
}

async function runScoutPhase(client: WorkflowClient, options: DynamicWorkflowOptions): Promise<import("./types.js").ScoutFindings> {
  const sessionId = await client.createSession("dynamic-workflow-scout")
  await client.initSession(sessionId)
  const model = resolveModel("scout", undefined, options.models)
  const result = await client.prompt(sessionId, buildScoutPrompt(options), {
    model,
    agent: "explore",
    format: jsonSchema(SCOUT_SCHEMA, 2),
  })
  if (options.cleanUpSessions) await client.deleteSession(sessionId)

  const structured = result.structured as Record<string, unknown> | undefined
  if (!structured) {
    return {
      filePaths: [],
      dependencyGraph: {},
      testLocations: [],
      complexityEstimate: "medium",
      summary: result.text?.slice(0, 2000) ?? "",
      risks: [],
      recommendedPhases: ["survey", "execute", "verify"],
    }
  }

  const filePaths = Array.isArray(structured.filePaths)
    ? structured.filePaths.filter((f): f is string => typeof f === "string")
    : []
  const dependencyGraph: Record<string, string[]> = {}
  if (structured.dependencyGraph && typeof structured.dependencyGraph === "object") {
    for (const [key, value] of Object.entries(structured.dependencyGraph)) {
      if (Array.isArray(value)) {
        dependencyGraph[key] = value.filter((v): v is string => typeof v === "string")
      }
    }
  }
  const testLocations = Array.isArray(structured.testLocations)
    ? structured.testLocations.filter((f): f is string => typeof f === "string")
    : []
  const risks = Array.isArray(structured.risks)
    ? structured.risks.filter((r): r is string => typeof r === "string")
    : []
  const recommendedPhases = Array.isArray(structured.recommendedPhases)
    ? structured.recommendedPhases.filter((p): p is string => typeof p === "string")
    : []

  return {
    filePaths,
    dependencyGraph,
    testLocations,
    complexityEstimate: (String(structured.complexityEstimate) as import("./types.js").EffortLevel) || "medium",
    summary: String(structured.summary || ""),
    risks,
    recommendedPhases,
  }
}

function buildScoutPrompt(options: DynamicWorkflowOptions): string {
  return [
    "You are a codebase scout for an OpenCode dynamic workflow.",
    "Your job is to map the codebase to inform a planner that will decompose work into agent tasks.",
    "",
    `Objective: ${options.objective}`,
    `Working directory: ${options.cwd}`,
    "",
    "Scout rules:",
    "- Use OpenCode file and find tools to explore the codebase.",
    "- Identify concrete file paths relevant to the objective.",
    "- Map dependency relationships between key files.",
    "- Locate test files that cover relevant code.",
    "- Estimate complexity (low/medium/high/ultra).",
    "- Note risks, blockers, and recommended phase breakdown.",
    "- Do not make changes to the codebase.",
    "",
    "Return findings using the structured schema.",
  ].join("\n")
}

function formatScoutFindings(findings: import("./types.js").ScoutFindings): string {
  const lines = [
    `Complexity: ${findings.complexityEstimate}`,
    `Summary: ${findings.summary}`,
    "",
    "Files:",
    ...findings.filePaths.map((f) => `  - ${f}`),
    "",
    "Tests:",
    ...findings.testLocations.map((t) => `  - ${t}`),
    "",
    "Risks:",
    ...findings.risks.map((r) => `  - ${r}`),
    "",
    "Recommended phases:",
    ...findings.recommendedPhases.map((p) => `  - ${p}`),
    "",
    "Dependencies:",
    ...Object.entries(findings.dependencyGraph).map(([file, deps]) => `  ${file} → ${deps.join(", ")}`),
  ]
  return lines.join("\n")
}

function estimatePlanTokens(plan: WorkflowPlan): number {
  const taskCount = plan.phases.reduce((sum, p) => sum + p.tasks.length, 0)
  // Rough heuristic: ~2k tokens per task for worker, ~1k for verifier, ~3k for synthesis
  const workerTokens = taskCount * 2000
  const verifierTokens = taskCount * 1000
  const synthesisTokens = 3000 + taskCount * 500
  return workerTokens + verifierTokens + synthesisTokens
}

function estimateCost(tokens: number, model?: string): number | undefined {
  if (!model) return undefined
  // Rough cost estimates per 1M tokens (input + output averaged)
  const rates: Record<string, number> = {
    "openai/gpt-5.1-codex": 3.0,
    "anthropic/claude-sonnet-4-5": 3.0,
    "anthropic/claude-opus-4-8": 15.0,
    "google/gemini-3-pro": 1.5,
  }
  const rate = rates[model] ?? 3.0
  return Math.round((tokens / 1_000_000) * rate * 100) / 100
}

function generateOrchestrationScript(plan: WorkflowPlan, options: DynamicWorkflowOptions): string {
  const lines = [
    `// Dynamic Orchestration Script for: ${plan.title}`,
    `// Generated by OpenCode Dynamic Workflows`,
    ``,
    `import type { DynamicWorkflowOptions, WorkflowPlan } from "./types.js"`,
    ``,
    `export async function orchestrate(plan: WorkflowPlan, options: DynamicWorkflowOptions, runner: any) {`,
    `  // Custom orchestration logic generated by the planner`,
    `  // This script can define loops, conditionals, and custom coordination patterns`,
    ``,
    `  for (const phase of plan.phases) {`,
    `    // Phase execution hook`,
    `    // Phase-specific logic can be injected here`,
    `    await runner.runPhase(phase)`,
    `  }`,
    ``,
    `  // Post-execution hooks`,
    `  await runner.synthesize()`,
    `}`,
    ``,
    `export const meta = {`,
    `  title: ${JSON.stringify(plan.title)},`,
    `  estimatedAgents: ${plan.maxAgentEstimate},`,
    `  phases: ${plan.phases.length},`,
    `  concurrency: ${options.concurrency},`,
    `}`,
  ]
  return lines.join("\n")
}

function cleanId(value: string, fallback: string): string {
  const slug = slugify(value)
  return slug || fallback
}

function fallbackPlan(options: DynamicWorkflowOptions): WorkflowPlan {
  return {
    title: "Dynamic workflow",
    summary: "Fallback plan generated because the planner did not return a usable structured plan.",
    maxAgentEstimate: 4,
    requiresApproval: false,
    phases: [
      {
        id: "survey",
        title: "Survey the codebase",
        description: "Identify relevant files, risks, and natural workstreams.",
        strategy: "Use one scout session to map the objective before making changes.",
        dependsOn: [],
        qualityGates: [],
        verification: { strategy: "Check that the survey names concrete files and next steps." },
        tasks: [
          {
            id: "survey-scout",
            title: "Survey repository for the objective",
            prompt: `Survey the repository for this objective and return concrete files, risks, workstreams, and validation commands: ${options.objective}`,
            role: "scout",
            targetFiles: [],
            acceptanceCriteria: ["Names concrete files or directories", "Proposes validation commands", "Identifies independent workstreams"],
            expectedArtifacts: ["survey report"],
            canEdit: false,
            dependsOn: [],
          },
        ],
      },
      {
        id: "execute",
        title: "Execute scoped work",
        description: "Perform the requested work using the survey as context.",
        strategy: "Use a worker session to make progress and record evidence.",
        dependsOn: ["survey"],
        qualityGates: [],
        verification: { strategy: "Run a verifier against acceptance criteria and evidence." },
        tasks: [
          {
            id: "execute-worker",
            title: "Implement or analyze requested objective",
            prompt: `Use the prior survey context and complete this objective as far as possible with verifiable evidence: ${options.objective}`,
            role: "worker",
            targetFiles: [],
            acceptanceCriteria: ["Addresses the objective", "Records files changed or inspected", "Reports validation evidence"],
            expectedArtifacts: ["implementation notes or patch"],
            canEdit: true,
            dependsOn: ["survey-scout"],
          },
        ],
      },
    ],
  }
}
