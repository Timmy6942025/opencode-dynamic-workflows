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

// Detect dry-run patterns in the user's input (requires explicit indicators)
function containsDryRunHint(objective: string): boolean {
  const lower = objective.toLowerCase()
  return /--dry[- ]?run|dry[- ]?run|plan only|just plan|show.me plan|what (will|happens? if)|simulate|test run/i.test(lower)
}

const WORKFLOW_DESCRIPTION = [
  "Launch a dynamic workflow that generates a custom JavaScript harness script for the task, then executes it with multi-agent orchestration.",
  "",
  "The planner writes a tailor-made workflow script using spawn/wait/parallel/forEach/synthesize/adversarial primitives.",
  "Each spawned agent runs in its own isolated OpenCode session with its own context window.",
  "",
  "Use dynamic_workflow_run only when the user explicitly asks for a workflow, multi-agent orchestration, fan-out, or coordinated task execution.",
  "For simple single-file edits or quick questions, use ordinary OpenCode tools instead.",
  "",
  "Guidelines:",
  "- objective is required and should be a clear, actionable goal.",
  "- stopping_condition is optional but strongly recommended for verifiable end states.",
  "- Use template to select a built-in workflow (e.g., 'deep-research', 'codebase-audit', 'large-migration', 'test-generation', 'refactor', 'feature').",
  "- Use skill to apply constraints like 'no-casts', 'test-driven', 'strict-types'.",
  "- Set require_approval=true when the plan should be reviewed before execution.",
  "- Set adversarial_review=true for independent verification of agent outputs.",
  "- background defaults to true; set false only when you need synchronous completion.",
  "- effort controls script complexity: low (simple sequential), medium (fan-out), high (multi-pattern), ultra (tournament + adversarial).",
  "- Models are specified as OpenCode provider/model ids (e.g., 'anthropic/claude-sonnet-4-5').",
  "- Each spawn() creates an isolated OpenCode session with its own context window.",
  "- The generated script uses standard JavaScript (loops, conditionals, Math, Array) plus the workflow API.",
].join("\n")

export const DynamicWorkflowsPlugin: Plugin = async (ctx) => {
  ctx.client.app.log({
    body: {
      service: "oc-dw",
      level: "info",
      message: `oc-dw plugin loaded (cwd: ${ctx.directory})`,
      extra: { worktree: ctx.worktree },
    },
  })

  return {
    tool: {
      dynamic_workflow_run: tool({
        description: WORKFLOW_DESCRIPTION,
        args: {
          objective: tool.schema.string().describe("The workflow objective — a clear, actionable goal for the dynamic workflow to accomplish."),
          stopping_condition: tool.schema.string().optional().describe("An explicit, verifiable end state that determines when the workflow is complete. When specified, the workflow stops when this condition is satisfied."),
          max_agents: tool.schema.number().optional().describe("Maximum number of worker tasks allowed. Defaults to 1000. Use to bound resource usage on large workflows."),
          concurrency: tool.schema.number().optional().describe("Maximum number of concurrent OpenCode sessions. Defaults to 16. Higher values speed up fan-out but increase API usage."),
          planner_model: tool.schema.string().optional().describe("OpenCode provider/model id for the planning agent (e.g., 'anthropic/claude-sonnet-4-5'). When not set, uses the default model."),
          worker_model: tool.schema.string().optional().describe("OpenCode provider/model id for worker agents. When not set, uses the default model."),
          verifier_model: tool.schema.string().optional().describe("OpenCode provider/model id for verification agents. When not set, uses the default model."),
          synthesizer_model: tool.schema.string().optional().describe("OpenCode provider/model id for the synthesis agent. When not set, uses the default model."),
          background: tool.schema.boolean().optional().describe("Run the workflow in the background and return immediately. Defaults to true. Set to false for synchronous completion in the tool call."),
          effort: tool.schema.enum(["low", "medium", "high", "ultra"]).optional().describe("Planning effort level. Controls script complexity: low (simple sequential), medium (fan-out), high (multi-pattern), ultra (tournament + adversarial). Defaults to high."),
          require_approval: tool.schema.boolean().optional().describe("When true, the workflow pauses after planning and requests human approval before executing any tasks."),
          adversarial_review: tool.schema.boolean().optional().describe("Enable adversarial review: spawn independent reviewer agents to verify convergence before marking tasks complete."),
          template: tool.schema.string().optional().describe("Built-in workflow template id to use (e.g., 'deep-research', 'codebase-audit', 'large-migration', 'test-generation'). Template is applied before planning."),
          skill: tool.schema.array(tool.schema.string()).optional().describe("Skill constraints to apply to all workers (e.g., 'security-first', 'test-driven', 'strict-types', 'docs-required')."),
          token_budget: tool.schema.number().optional().describe("Maximum token budget for the entire workflow. When exceeded, the workflow pauses and reports partial results."),
          save_workflow: tool.schema.boolean().optional().describe("When true, saves the completed workflow as a reusable template under .opencode/dynamic-workflows/templates/."),
          workflow_name: tool.schema.string().optional().describe("Name for the saved workflow template. Required when save_workflow is true."),
          dry_run: tool.schema.boolean().optional().describe("Preview the workflow plan without executing any tasks. The plan is written to .opencode/dynamic-workflows/runs/<id>/plan.json."),
        },
        async execute(args) {
          const normalized = normalizeWorkflowArgs(args)
          const cwd = ctx.worktree || ctx.directory
          const objective = String(normalized.objective)

          ctx.client.app.log({
            body: {
              service: "oc-dw",
              level: "debug",
              message: `dynamic_workflow_run invoked: ${objective.slice(0, 80)}`,
            },
          })

          const options = defaultWorkflowOptions(objective, cwd)
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
          const dryRunHint = containsDryRunHint(objective)
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

            ctx.client.app.log({
              body: {
                service: "oc-dw",
                level: "info",
                message: `Workflow ${state.id} started in background${options.dryRun ? " (dry run)" : ""}`,
                extra: { workflowId: state.id, dryRun: options.dryRun },
              },
            })

            if (options.dryRun) {
              return `Dry run: workflow ${state.id} planned (not executed). Plan artifact: .opencode/dynamic-workflows/runs/${state.id}/plan.json`
            }
            return `Started dynamic workflow ${state.id}. Status and artifacts are under .opencode/dynamic-workflows/runs/${state.id}.`
          }

          const state = await runner.run(options)

          ctx.client.app.log({
            body: {
              service: "oc-dw",
              level: "info",
              message: `Workflow ${state.id} completed with status ${state.status}`,
              extra: { workflowId: state.id, status: state.status, tokens: state.totalTokensUsed },
            },
          })

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
      `Script: .opencode/dynamic-workflows/runs/${state.id}/workflow-script.js`,
      `Plan: .opencode/dynamic-workflows/runs/${state.id}/plan.json`,
    ]
    return lines.join("\n")
  }
  const agents = state.agentLog
  const completed = agents.filter((a) => a.status === "completed").length
  const failed = agents.filter((a) => a.status === "failed").length
  const lines = [
    `Workflow ${state.id} finished with status ${state.status}.`,
    `Summary: ${state.summaryPath ?? "not written"}`,
    `Agents: ${completed}/${agents.length} completed${failed > 0 ? `, ${failed} failed` : ""}`,
    `Tokens used: ${state.totalTokensUsed}`,
  ]
  if (state.error) lines.push(`Error: ${state.error}`)
  return lines.join("\n")
}

export default DynamicWorkflowsPlugin
