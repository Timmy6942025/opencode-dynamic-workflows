import type { AgentTask, DynamicWorkflowOptions, ModelRole, WorkflowClient, WorkflowPhase, WorkflowPlan } from "./types.js"
import { resolveModel } from "./model-router.js"
import { coerceStringArray, jsonSchema, slugify, stableId } from "./util.js"

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
  const sessionId = await client.createSession("dynamic-workflow-planner")
  await client.initSession(sessionId)
  const model = resolveModel("planner", undefined, options.models)
  const result = await client.prompt(sessionId, buildPlannerPrompt(options), {
    model,
    agent: "plan",
    format: jsonSchema(PLAN_SCHEMA, 3),
  })
  const structured = result.structured as unknown
  const plan = normalizePlan(structured, options)
  if (plan.phases.length === 0) {
    return fallbackPlan(options)
  }
  return plan
}

export function buildPlannerPrompt(options: DynamicWorkflowOptions): string {
  return [
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
    `Working directory: ${options.cwd}`,
    `Max total worker tasks: ${options.maxAgents}`,
    `Max concurrent sessions: ${options.concurrency}`,
    `Verification rounds requested: ${options.verificationRounds}`,
    "",
    "Return only the structured plan matching the schema.",
  ].join("\n")
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
  if (value === "scout" || value === "critic") return value
  return "worker"
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
