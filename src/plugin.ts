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
          max_agents: tool.schema.number().optional().describe("Maximum worker tasks to allow. Defaults to 1000."),
          concurrency: tool.schema.number().optional().describe("Maximum concurrent OpenCode sessions. Defaults to 16."),
          planner_model: tool.schema.string().optional().describe("Optional OpenCode provider/model id for planning."),
          worker_model: tool.schema.string().optional().describe("Optional OpenCode provider/model id for workers."),
          verifier_model: tool.schema.string().optional().describe("Optional OpenCode provider/model id for verification."),
          synthesizer_model: tool.schema.string().optional().describe("Optional OpenCode provider/model id for synthesis."),
          background: tool.schema.boolean().optional().describe("Run in the background. Defaults to true."),
        },
        async execute(args) {
          const cwd = ctx.worktree || ctx.directory
          const options = defaultWorkflowOptions(args.objective, cwd)
          if (args.max_agents) options.maxAgents = args.max_agents
          if (args.concurrency) options.concurrency = args.concurrency
          options.models = {
            planner: args.planner_model,
            worker: args.worker_model,
            verifier: args.verifier_model,
            synthesizer: args.synthesizer_model,
          }
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
