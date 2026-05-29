import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import { SdkLikeWorkflowClient } from "./client.js"
import { defaultWorkflowOptions } from "./options.js"
import { ConsoleReporter } from "./reporter.js"
import { DynamicWorkflowRunner } from "./runner.js"
import { FileWorkflowStore } from "./state.js"
import type { WorkflowState } from "./types.js"

function normalizeWorkflowArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") {
    throw new Error("dynamic_workflow_run requires an object argument with an objective string")
  }
  const value = args as Record<string, unknown>
  if (typeof value.objective !== "string" || !value.objective.trim()) {
    throw new Error("dynamic_workflow_run requires a non-empty objective string")
  }
  return value
}

// Detect dry-run patterns in the user's input
function containsDryRunHint(objective: string): boolean {
  const lower = objective.toLowerCase()
  return /--dry[- ]?run|preview|plan only|dry[- ]?run|just plan|show me (the )?plan|what (would|will) (happen|be done)/.test(lower)
}

const WORKFLOW_DESCRIPTION = [
  "Launch a model-agnostic dynamic workflow that plans, fans out OpenCode subagents, verifies results, checkpoints state, and synthesizes a final report.",
  "",
  "Use dynamic_workflow_run only when the user explicitly asks for a workflow, multi-agent orchestration, fan-out, or coordinated task execution.",
  "For simple single-file edits or quick questions, use ordinary OpenCode tools instead.",
  "",
  "Guidelines:",
  "- objective is required and should be a clear, actionable goal.",
  "- stopping_condition is optional but strongly recommended for verifiable end states.",
  "- Use template to select a built-in workflow (e.g., 'deep-research', 'audit', 'migration').",
  "- Use skill to apply constraints like 'no-casts', 'test-driven', 'strict-types'.",
  "- Set require_approval=true when the plan should be reviewed before execution.",
  "- Set adversarial_review=true for independent verification and convergence detection.",
  "- background defaults to true; set false only when you need synchronous completion.",
  "- effort controls plan granularity: low (1-2 phases), medium (3-4), high (5-8), ultra (9+).",
  "- Models are specified as OpenCode provider/model ids (e.g., 'anthropic/claude-sonnet-4-5').",
  "- Every workflow spawns isolated worker sessions with scoped prompts and acceptance criteria.",
  "- Workers may read, edit, and run commands through OpenCode according to canEdit.",
  "- Failed workers return null and log the failure unless the workflow is aborted.",
].join("\n")

export const DynamicWorkflowsPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      dynamic_workflow_run: tool({
        description: WORKFLOW_DESCRIPTION,
        args: {
          objective: tool.schema.string().describe("The workflow objective."),
          stopping_condition: tool.schema.string().optional().describe("Explicit stopping condition / verifiable end state."),
          max_agents: tool.schema.number().optional().describe("Maximum worker tasks to allow. Defaults to 1000."),
          concurrency: tool.schema.number().optional().describe("Maximum concurrent OpenCode sessions. Defaults to 16."),
          planner_model: tool.schema.string().optional().describe("Optional OpenCode provider/model id for planning."),
          worker_model: tool.schema.string().optional().describe("Optional OpenCode provider/model id for workers."),
          verifier_model: tool.schema.string().optional().describe("Optional OpenCode provider/model id for verification."),
          synthesizer_model: tool.schema.string().optional().describe("Optional OpenCode provider/model id for synthesis."),
          background: tool.schema.boolean().optional().describe("Run in the background. Defaults to true."),
          effort: tool.schema.enum(["low", "medium", "high", "ultra"]).optional().describe("Effort level. Defaults to high."),
          require_approval: tool.schema.boolean().optional().describe("Require human approval before executing plan."),
          adversarial_review: tool.schema.boolean().optional().describe("Enable adversarial review with convergence."),
          template: tool.schema.string().optional().describe("Built-in workflow template id."),
          skill: tool.schema.array(tool.schema.string()).optional().describe("Skill constraints to apply."),
          token_budget: tool.schema.number().optional().describe("Maximum token budget."),
          save_workflow: tool.schema.boolean().optional().describe("Save as reusable workflow template."),
          workflow_name: tool.schema.string().optional().describe("Name for saved workflow."),
          dry_run: tool.schema.boolean().optional().describe("Preview the workflow plan without executing tasks."),
        },
        async execute(args) {
          const normalized = normalizeWorkflowArgs(args)
          const cwd = ctx.worktree || ctx.directory
          const options = defaultWorkflowOptions(String(normalized.objective), cwd)
          if (typeof normalized.stopping_condition === "string") options.stoppingCondition = normalized.stopping_condition
          if (typeof normalized.max_agents === "number") options.maxAgents = normalized.max_agents
          if (typeof normalized.concurrency === "number") options.concurrency = normalized.concurrency
          options.models = {
            planner: typeof normalized.planner_model === "string" ? normalized.planner_model : undefined,
            worker: typeof normalized.worker_model === "string" ? normalized.worker_model : undefined,
            verifier: typeof normalized.verifier_model === "string" ? normalized.verifier_model : undefined,
            synthesizer: typeof normalized.synthesizer_model === "string" ? normalized.synthesizer_model : undefined,
          }
          if (typeof normalized.effort === "string" && ["low", "medium", "high", "ultra"].includes(normalized.effort)) {
            options.effortLevel = normalized.effort as typeof options.effortLevel
          }
          if (normalized.require_approval === true) options.requireApproval = true
          if (normalized.adversarial_review === true) options.adversarialReview = true
          if (typeof normalized.template === "string") options.template = normalized.template
          if (Array.isArray(normalized.skill)) options.skills = normalized.skill.filter((s): s is string => typeof s === "string")
          if (typeof normalized.token_budget === "number") options.tokenBudget = normalized.token_budget
          if (normalized.save_workflow === true) options.saveWorkflow = true
          if (typeof normalized.workflow_name === "string") options.workflowName = normalized.workflow_name

          // Handle dry_run: explicit flag OR auto-detected from language hints
          const dryRunExplicit = normalized.dry_run === true
          const dryRunHint = containsDryRunHint(String(normalized.objective))
          options.dryRun = dryRunExplicit || dryRunHint

          const client = new SdkLikeWorkflowClient(ctx.client)
          const store = new FileWorkflowStore(cwd)
          const reporter = new ConsoleReporter()
          const runner = new DynamicWorkflowRunner(client, store, reporter)

          if (normalized.background !== false) {
            const state = await store.create(options)
            const backgroundOptions = { ...options, workflowId: state.id }
            void runner.run(backgroundOptions).catch(async (error) => {
              await ctx.client.app.log({
                body: {
                  service: "oc-dw",
                  level: "error",
                  message: error instanceof Error ? error.message : String(error),
                  extra: { workflowId: state.id },
                },
              })
            })

            if (options.dryRun) {
              return `Dry run: workflow ${state.id} planned (not executed). Plan artifact: .opencode/dynamic-workflows/runs/${state.id}/plan.json`
            }
            return `Started dynamic workflow ${state.id}. Status and artifacts are under .opencode/dynamic-workflows/runs/${state.id}.`
          }

          const state = await runner.run(options)
          return formatWorkflowResult(state, options.dryRun)
        },
      }),
    },

  }
}

function formatWorkflowResult(state: WorkflowState, dryRun = false): string {
  if (dryRun || state.status === "paused") {
    const lines = [
      `(dry run) Workflow ${state.id} planned — not executed.`,
      `Plan: .opencode/dynamic-workflows/runs/${state.id}/plan.json`,
      `Phases: ${Object.keys(state.phases).length} planned`,
      `Tasks: ${Object.keys(state.tasks).length} planned`,
    ]
    return lines.join("\n")
  }
  const lines = [
    `Workflow ${state.id} finished with status ${state.status}.`,
    `Summary: ${state.summaryPath ?? "not written"}`,
    `Phases: ${Object.values(state.phases).filter((p) => p.status === "completed").length}/${Object.keys(state.phases).length} completed`,
    `Tasks: ${Object.values(state.tasks).filter((t) => t.status === "completed").length}/${Object.keys(state.tasks).length} completed`,
    `Tokens used: ${state.totalTokensUsed}`,
  ]
  if (state.error) lines.push(`Error: ${state.error}`)
  return lines.join("\n")
}

export default DynamicWorkflowsPlugin
