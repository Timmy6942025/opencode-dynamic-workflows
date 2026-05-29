import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

import { SdkLikeWorkflowClient } from "./client.js"
import { defaultWorkflowOptions } from "./options.js"
import { SilentReporter } from "./reporter.js"
import { DynamicWorkflowRunner } from "./runner.js"
import { FileWorkflowStore } from "./state.js"

export const DynamicWorkflowsPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      dynamic_workflow_run: tool({
        description: "Launch a model-agnostic dynamic workflow that plans, fans out OpenCode subagents, verifies results, checkpoints state, and synthesizes a final report.",
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
        },
        async execute(args) {
          const cwd = ctx.worktree || ctx.directory
          const options = defaultWorkflowOptions(args.objective, cwd)
          if (args.stopping_condition) options.stoppingCondition = args.stopping_condition
          if (args.max_agents) options.maxAgents = args.max_agents
          if (args.concurrency) options.concurrency = args.concurrency
          options.models = {
            planner: args.planner_model,
            worker: args.worker_model,
            verifier: args.verifier_model,
            synthesizer: args.synthesizer_model,
          }
          if (args.effort) options.effortLevel = args.effort
          if (args.require_approval) options.requireApproval = args.require_approval
          if (args.adversarial_review) options.adversarialReview = args.adversarial_review
          if (args.template) options.template = args.template
          if (args.skill) options.skills = args.skill
          if (args.token_budget) options.tokenBudget = args.token_budget
          if (args.save_workflow) options.saveWorkflow = args.save_workflow
          if (args.workflow_name) options.workflowName = args.workflow_name
          const client = new SdkLikeWorkflowClient(ctx.client)
          const store = new FileWorkflowStore(cwd)
          const runner = new DynamicWorkflowRunner(client, store, new SilentReporter())

          if (args.background !== false) {
            const state = await store.create(options)
            const backgroundOptions = { ...options, workflowId: state.id }
            void runner.run(backgroundOptions).catch(async (error) => {
              await ctx.client.app.log({
                body: {
                  service: "opencode-dynamic-workflows",
                  level: "error",
                  message: error instanceof Error ? error.message : String(error),
                  extra: { workflowId: state.id },
                },
              })
            })
            return `Started dynamic workflow ${state.id}. Status and artifacts are under .opencode/dynamic-workflows/runs/${state.id}.`
          }

          const state = await runner.run(options)
          return `Workflow ${state.id} finished with status ${state.status}.\nSummary: ${state.summaryPath ?? "not written"}`
        },
      }),
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await ctx.client.app.log({
          body: {
            service: "opencode-dynamic-workflows",
            level: "debug",
            message: "OpenCode session idle while dynamic workflow plugin is loaded",
          },
        })
      }
    },
  }
}

export default DynamicWorkflowsPlugin
