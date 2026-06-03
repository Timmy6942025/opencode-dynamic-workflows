import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import { SdkLikeWorkflowClient } from "./client.js"
import { defaultWorkflowOptions } from "./options.js"
import { ConsoleReporter } from "./reporter.js"
import { DynamicWorkflowRunner } from "./runner.js"
import { FileWorkflowStore } from "./state.js"
import type { WorkflowState } from "./types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function containsDryRunHint(objective: string): boolean {
  const lower = objective.toLowerCase()
  return /--dry[- ]?run|dry[- ]?run|plan only|just plan|show.me plan|what (will|happens? if)|simulate|test run/i.test(lower)
}

/**
 * Track active workflow runners so the dispose hook can abort them.
 * Each entry is the runner's AbortController and the set of session IDs to abort.
 */
const activeWorkflows = new Map<string, { controller: AbortController; store: FileWorkflowStore }>()

// ---------------------------------------------------------------------------
// Tool description — concise; detailed guidance lives in arg descriptions
// ---------------------------------------------------------------------------

const WORKFLOW_DESCRIPTION =
  "Launch a dynamic workflow that generates a custom JavaScript harness for the task, " +
  "then executes it with multi-agent orchestration. Each spawn() creates an isolated " +
  "OpenCode session. Use for complex multi-step tasks that benefit from parallel agent " +
  "coordination, adversarial verification, or iterative refinement. " +
  "For simple edits or quick questions, use ordinary tools instead."

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const DynamicWorkflowsPlugin: Plugin = async (ctx) => {
  await ctx.client.app.log({
    body: {
      service: "oc-dw",
      level: "info",
      message: `oc-dw plugin loaded (cwd: ${ctx.directory})`,
      extra: { worktree: ctx.worktree },
    },
  })

  return {
    // ---- Custom tool ----
    tool: {
      dynamic_workflow_run: tool({
        description: WORKFLOW_DESCRIPTION,
        args: {
          objective: tool.schema.string().describe(
            "The workflow objective — a clear, actionable goal. " +
            "The planner generates a custom JavaScript harness using spawn/wait/parallel/forEach/synthesize/adversarial primitives."
          ),
          stopping_condition: tool.schema.string().optional().describe(
            "An explicit, verifiable end state. When specified, the workflow stops when this condition is satisfied. " +
            "Strongly recommended for iterative workflows."
          ),
          max_agents: tool.schema.number().optional().describe(
            "Maximum worker tasks allowed (default: 1000). Bounds resource usage on large workflows."
          ),
          concurrency: tool.schema.number().optional().describe(
            "Maximum concurrent OpenCode sessions (default: 16). Higher values speed up fan-out but increase API usage."
          ),
          planner_model: tool.schema.string().optional().describe(
            "Provider/model id for the planning agent (e.g. 'anthropic/claude-sonnet-4-5'). Defaults to session model."
          ),
          worker_model: tool.schema.string().optional().describe(
            "Provider/model id for worker agents. Defaults to session model."
          ),
          verifier_model: tool.schema.string().optional().describe(
            "Provider/model id for verification agents. Defaults to session model."
          ),
          synthesizer_model: tool.schema.string().optional().describe(
            "Provider/model id for the synthesis agent. Defaults to session model."
          ),
          background: tool.schema.boolean().optional().describe(
            "Run in background and return immediately (default: true). Set false for synchronous completion."
          ),
          effort: tool.schema.enum(["low", "medium", "high", "ultra"]).optional().describe(
            "Script complexity: low (sequential), medium (fan-out), high (multi-pattern), ultra (tournament + adversarial). Default: high."
          ),
          require_approval: tool.schema.boolean().optional().describe(
            "Pause after planning and request human approval before executing."
          ),
          adversarial_review: tool.schema.boolean().optional().describe(
            "Spawn independent reviewer agents to verify convergence before marking tasks complete."
          ),
          template: tool.schema.string().optional().describe(
            "Built-in template id: 'deep-research', 'codebase-audit', 'large-migration', 'test-generation', 'refactor', 'feature', 'api-design', 'performance', 'dependency-audit'."
          ),
          skill: tool.schema.array(tool.schema.string()).optional().describe(
            "Constraints for all workers: 'no-casts', 'test-driven', 'minimal-diff', 'strict-types', 'security-first', 'performance-aware', 'docs-required', 'backward-compat'."
          ),
          token_budget: tool.schema.number().optional().describe(
            "Maximum token budget for the entire workflow. Pauses and reports partial results when exceeded."
          ),
          save_workflow: tool.schema.boolean().optional().describe(
            "Save the completed workflow as a reusable template under .opencode/dynamic-workflows/templates/."
          ),
          workflow_name: tool.schema.string().optional().describe(
            "Name for the saved template. Required when save_workflow is true."
          ),
          dry_run: tool.schema.boolean().optional().describe(
            "Preview the plan without executing. Also auto-detected from phrases like 'plan only' or 'what will happen'."
          ),
        },

        // ---- execute: uses ToolContext for directory, abort, metadata ----
        async execute(args, context) {
          const normalized = normalizeWorkflowArgs(args)
          const cwd = context.worktree || context.directory
          const objective = String(normalized.objective)

          // Progress reporting via ToolContext.metadata()
          const reportProgress = (title: string, meta?: Record<string, unknown>) => {
            try {
              context.metadata({ title, metadata: meta })
            } catch (err) {
              void ctx.client.app.log({
                body: { service: "oc-dw", level: "debug", message: `metadata() unavailable: ${err}` },
              })
            }
          }

          await ctx.client.app.log({
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

          // Wire abort: combine ToolContext.abort with our internal controller so
          // both the user (via context) and the dispose hook can cancel the workflow.
          const workflowAbort = new AbortController()
          context.abort.addEventListener("abort", () => workflowAbort.abort(), { once: true })
          options.signal = workflowAbort.signal

          // Wire progress callback
          options.onProgress = ({ title, metadata: meta }) => reportProgress(title ?? "", meta)

          // Handle dry_run: explicit flag OR auto-detected from language hints
          const dryRunExplicit = normalized.dry_run === true
          const dryRunHint = containsDryRunHint(objective)
          options.dryRun = dryRunExplicit || dryRunHint

          const client = new SdkLikeWorkflowClient(ctx.client, cwd)
          const store = new FileWorkflowStore(cwd)
          const reporter = new ConsoleReporter()
          const runner = new DynamicWorkflowRunner(client, store, reporter)

          // Track for dispose hook
          const workflowId = `wf-${Date.now()}`
          activeWorkflows.set(workflowId, { controller: workflowAbort, store })

          try {
            if (normalized.background !== false) {
              reportProgress("Planning workflow...")
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

              await ctx.client.app.log({
                body: {
                  service: "oc-dw",
                  level: "info",
                  message: `Workflow ${state.id} started in background${options.dryRun ? " (dry run)" : ""}`,
                  extra: { workflowId: state.id, dryRun: options.dryRun },
                },
              })

              if (options.dryRun) {
                return {
                  title: `Dry run: ${objective.slice(0, 60)}`,
                  output: `Dry run: workflow ${state.id} planned (not executed).\nPlan: .opencode/dynamic-workflows/runs/${state.id}/plan.json`,
                  metadata: { workflowId: state.id, dryRun: true, status: "planned" },
                }
              }
              return {
                title: `Workflow started: ${objective.slice(0, 60)}`,
                output: `Started dynamic workflow ${state.id}.\nArtifacts: .opencode/dynamic-workflows/runs/${state.id}/`,
                metadata: { workflowId: state.id, status: "running" },
              }
            }

            // Synchronous mode
            reportProgress("Planning workflow...")
            const state = await runner.run(options)

            await ctx.client.app.log({
              body: {
                service: "oc-dw",
                level: "info",
                message: `Workflow ${state.id} completed with status ${state.status}`,
                extra: { workflowId: state.id, status: state.status, tokens: state.totalTokensUsed },
              },
            })

            return formatWorkflowResult(state, options.dryRun)
          } finally {
            activeWorkflows.delete(workflowId)
          }
        },
      }),
    },

    // ---- Dispose hook: abort running workflows on exit ----
    dispose: async () => {
      for (const [id, entry] of activeWorkflows) {
        entry.controller.abort()
        activeWorkflows.delete(id)
      }
    },

    // ---- Shell env hook: inject oc-dw context into spawned shells ----
    ["shell.env"]: async (_input, output) => {
      output.env.OC_DW_VERSION = "0.3.2"
      output.env.OC_DW_PLUGIN = "true"
    },
  }
}

// ---------------------------------------------------------------------------
// Result formatting — returns structured ToolResult
// ---------------------------------------------------------------------------

function formatWorkflowResult(
  state: WorkflowState,
  dryRun = false,
): { title: string; output: string; metadata: Record<string, unknown> } {
  const agents = state.agentLog
  const completed = agents.filter((a) => a.status === "completed").length
  const failed = agents.filter((a) => a.status === "failed").length

  if (dryRun || state.status === "paused") {
    return {
      title: `Dry run: ${state.objective.slice(0, 60)}`,
      output: [
        `(dry run) Workflow ${state.id} planned — not executed.`,
        `Script: .opencode/dynamic-workflows/runs/${state.id}/workflow-script.js`,
        `Plan: .opencode/dynamic-workflows/runs/${state.id}/plan.json`,
      ].join("\n"),
      metadata: { workflowId: state.id, dryRun: true, status: state.status },
    }
  }

  return {
    title: `Workflow ${state.status}: ${state.objective.slice(0, 50)}`,
    output: [
      `Workflow ${state.id} finished with status ${state.status}.`,
      `Summary: ${state.summaryPath ?? "not written"}`,
      `Agents: ${completed}/${agents.length} completed${failed > 0 ? `, ${failed} failed` : ""}`,
      `Tokens used: ${state.totalTokensUsed}`,
      ...(state.error ? [`Error: ${state.error}`] : []),
    ].join("\n"),
    metadata: {
      workflowId: state.id,
      status: state.status,
      agentsCompleted: completed,
      agentsFailed: failed,
      agentsTotal: agents.length,
      tokensUsed: state.totalTokensUsed,
    },
  }
}

// ---------------------------------------------------------------------------
// V1 PluginModule default export
// ---------------------------------------------------------------------------

// OpenCode's readV1Plugin() checks isRecord(default) for a .server property.
const DynamicWorkflowsPluginModule: PluginModule = { id: "oc-dw", server: DynamicWorkflowsPlugin }
export default DynamicWorkflowsPluginModule
