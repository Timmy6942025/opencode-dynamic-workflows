import type {
  DynamicWorkflowOptions,
  Reporter,
  WorkflowClient,
  WorkflowState,
} from "./types.js"
import { createDynamicPlan } from "./planner.js"
import { FileWorkflowStore } from "./state.js"
import { nowIso, toErrorMessage } from "./util.js"
import { SilentReporter } from "./reporter.js"
import { ScriptExecutor } from "./script-executor.js"
import { requestApproval } from "./approval.js"
import { createWorktree, cleanupWorktree } from "./worktree.js"

/**
 * Orchestrator that generates a workflow script via the planner, then
 * executes it through the ScriptExecutor. Replaces the old phase/task DAG.
 */
export class DynamicWorkflowRunner {
  constructor(
    private readonly client: WorkflowClient,
    private readonly store: FileWorkflowStore,
    private readonly reporter: Reporter = new SilentReporter(),
  ) {}

  private throwIfAborted(options: DynamicWorkflowOptions): void {
    if (options.signal?.aborted) throw new Error("workflow aborted")
  }

  async run(options: DynamicWorkflowOptions): Promise<WorkflowState> {
    // ---- Load or create state ----
    let state = options.workflowId
      ? await this.store.load(options.workflowId)
      : await this.store.create(options)
    this.throwIfAborted(options)

    // ---- Planning step (generate the workflow script) ----
    if (!state.script) {
      this.reporter.info("Planning workflow", { workflowId: state.id })
      state.status = "planning"
      await this.store.save(state)

      // Apply template if specified
      if (options.template) {
        const { resolveTemplate, applyTemplate } = await import("./templates.js")
        const template = resolveTemplate(options.template)
        if (template) {
          this.reporter.info(`Applying workflow template: ${template.name}`, { templateId: template.id })
          options = applyTemplate(template, options)
        }
      }

      this.throwIfAborted(options)
      const plan = await createDynamicPlan(this.client, options)

      // Persist the plan and script
      await this.store.mutateState(state.id, (s) => {
        s.plan = plan
        s.script = plan.script
      })
      state = await this.store.load(state.id)
      await this.store.writeArtifact(state.id, "plan.json", `${JSON.stringify({ title: plan.title, summary: plan.summary, maxAgentEstimate: plan.maxAgentEstimate, estimatedTokens: plan.estimatedTokens, estimatedCost: plan.estimatedCost }, null, 2)}\n`)
      await this.store.writeArtifact(state.id, "workflow-script.js", plan.script)
      await this.store.appendEvent(state.id, {
        time: nowIso(),
        type: "workflow.planned",
        message: "Workflow script generated",
        details: { title: plan.title, maxAgentEstimate: plan.maxAgentEstimate, estimatedTokens: plan.estimatedTokens },
      })

      // Approval gate
      if (options.requireApproval) {
        const approval = await requestApproval(state, plan, options, this.reporter, this.store)
        if (approval === "rejected") {
          await this.store.mutateState(state.id, (s) => { s.status = "aborted" })
          return await this.store.load(state.id)
        }
        state = await this.store.load(state.id)
      }
    } else {
      this.reporter.info("Resuming workflow with existing script", { workflowId: state.id })
    }

    // ---- Dry run: stop after planning ----
    if (options.dryRun) {
      await this.store.mutateState(state.id, (s) => { s.status = "paused" })
      return await this.store.load(state.id)
    }

    // ---- Worktree setup ----
    if (options.useWorktree && options.worktreeName) {
      const worktreePath = await createWorktree(state.cwd, options.worktreeName, this.reporter)
      await this.store.mutateState(state.id, (s) => {
        s.worktreePath = worktreePath
        s.cwd = worktreePath
      })
      state = await this.store.load(state.id)
    }

    // ---- Execute the script ----
    await this.store.mutateState(state.id, (s) => { s.status = "running" })
    state = await this.store.load(state.id)
    this.reporter.info("Executing workflow script", { workflowId: state.id })

    try {
      const executor = new ScriptExecutor(this.client, options, this.reporter)
      const script = state.script!
      const result = await executor.execute(state, script)

      state = await this.store.load(state.id)

      if (result.error) {
        await this.store.mutateState(state.id, (s) => {
          s.status = "failed"
          s.error = result.error
          s.scriptOutput = result.output
          s.totalTokensUsed += result.tokensUsed
          s.agentLog = result.runtime.agents.map((a) => ({
            id: a.id,
            label: a.label,
            status: "completed" as const,
            tokensUsed: 0,
            startedAt: nowIso(),
          }))
        })
        const failedState = await this.store.load(state.id)
        await this.store.appendEvent(state.id, { time: nowIso(), type: "workflow.failed", message: result.error })
        this.reporter.error("Workflow script failed", { workflowId: state.id, error: result.error, durationMs: result.durationMs })
        return failedState
      }

      // ---- Success ----
      const summaryPath = result.output
        ? await this.store.writeArtifact(state.id, "summary.md", result.output)
        : undefined

      // Build agent log entries from the runtime's internal agent data
      const agentEntries = result.runtime.agents.map((a) => {
        // We can't easily get the resolved result here, but we know the script completed
        // so agents that were waited on are completed
        return {
          id: a.id,
          label: a.label,
          status: "completed" as const,
          tokensUsed: 0,
          startedAt: nowIso(),
        }
      })

      await this.store.mutateState(state.id, (s) => {
        s.status = "completed"
        s.scriptOutput = result.output
        s.summary = result.output
        s.summaryPath = summaryPath
        s.totalTokensUsed += result.tokensUsed
        s.agentLog = agentEntries
      })

      const completedState = await this.store.load(state.id)
      await this.store.appendEvent(state.id, {
        time: nowIso(),
        type: "workflow.completed",
        message: "Workflow completed",
        details: { summaryPath, durationMs: result.durationMs, tokensUsed: result.tokensUsed, agentsSpawned: result.runtime.agents.length },
      })

      this.reporter.info("Workflow completed", {
        workflowId: state.id,
        durationMs: result.durationMs,
        tokensUsed: result.tokensUsed,
        agentsSpawned: result.runtime.agents.length,
      })

      // Save workflow as template if requested
      if (options.saveWorkflow && options.workflowName) {
        await this.store.mutateState(state.id, (s) => {
          s.isTemplate = true
          s.templateName = options.workflowName
        })
        await this.store.saveWorkflowTemplate(state.id, options.workflowName!, completedState)
      }

      // Cleanup worktree
      if (options.useWorktree && options.worktreeName) {
        await cleanupWorktree(options.cwd, options.worktreeName, this.reporter)
      }

      return completedState
    } catch (error) {
      if (options.signal?.aborted) throw error
      const errorMessage = toErrorMessage(error)
      state = await this.store.load(state.id)
      await this.store.mutateState(state.id, (s) => {
        s.status = "failed"
        s.error = errorMessage
      })
      const failedState = await this.store.load(state.id)
      await this.store.appendEvent(state.id, { time: nowIso(), type: "workflow.failed", message: errorMessage })
      this.reporter.error("Workflow failed", { workflowId: state.id, error: errorMessage })
      return failedState
    }
  }

  async abort(workflowId: string): Promise<WorkflowState> {
    const state = await this.store.load(workflowId)
    state.status = "aborted"
    await Promise.all(state.sessions.map((sessionId) => this.client.abortSession(sessionId)))
    await this.store.save(state)
    await this.store.appendEvent(workflowId, { time: nowIso(), type: "workflow.aborted", message: "Workflow aborted" })
    return state
  }

  async pause(workflowId: string): Promise<WorkflowState> {
    const state = await this.store.load(workflowId)
    state.status = "paused"
    await this.store.save(state)
    await this.store.appendEvent(workflowId, { time: nowIso(), type: "workflow.paused", message: "Workflow paused" })
    return state
  }
}
