import type {
  AgentTask,
  DynamicWorkflowOptions,
  PhaseRunState,
  Reporter,
  ShellResult,
  TaskAttempt,
  TaskRunState,
  VerificationResult,
  WorkflowClient,
  WorkflowPhase,
  WorkflowState,
} from "./types.js"
import { resolveModel } from "./model-router.js"
import { createDynamicPlan } from "./planner.js"
import { FileWorkflowStore, initializePlanState } from "./state.js"
import { chunkArray, jsonSchema, mapLimit, nowIso, toErrorMessage, truncate } from "./util.js"
import { SilentReporter } from "./reporter.js"
import { runAdversarialReview } from "./adversarial.js"
import { generateProgressReport, synthesizeProgressReport } from "./progress.js"
import { applySkillsToTask, resolveSkills } from "./skills.js"
import { requestApproval } from "./approval.js"
import { createWorktree, cleanupWorktree } from "./worktree.js"

const VERIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pass: { type: "boolean", description: "True only if the output satisfies the task acceptance criteria." },
    confidence: { type: "number", description: "0 to 1 confidence in this judgment." },
    issues: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
    followUpPrompt: { type: "string", description: "Prompt to send a worker if retry is needed." },
  },
  required: ["pass", "confidence", "issues", "evidence"],
}

export class DynamicWorkflowRunner {
  constructor(
    private readonly client: WorkflowClient,
    private readonly store: FileWorkflowStore,
    private readonly reporter: Reporter = new SilentReporter(),
  ) {}

  async run(options: DynamicWorkflowOptions): Promise<WorkflowState> {
    let state = options.workflowId ? await this.store.load(options.workflowId) : await this.store.create(options)
    await this.client.health()

    if (!state.plan) {
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

      const plan = await createDynamicPlan(this.client, options)
      initializePlanState(state, plan)
      await this.store.writeArtifact(state.id, "plan.json", `${JSON.stringify(plan, null, 2)}\n`)
      if (plan.orchestrationScript) {
        await this.store.writeArtifact(state.id, "orchestration.ts", plan.orchestrationScript)
      }
      await this.event(state.id, "workflow.planned", "Workflow plan created", {
        phases: plan.phases.length,
        tasks: Object.keys(state.tasks).length,
        estimatedTokens: plan.estimatedTokens,
      })
      await this.store.save(state)

      // Approval gate
      if (options.requireApproval) {
        const approval = await requestApproval(state, plan, options, this.reporter, this.store)
        if (approval === "rejected") {
          state = await this.store.load(state.id)
          state.status = "aborted"
          await this.store.save(state)
          return state
        }
        state = await this.store.load(state.id)
      }
    }

    if (options.dryRun) {
      state.status = "paused"
      await this.store.save(state)
      return state
    }

    // Worktree setup
    if (options.useWorktree && options.worktreeName) {
      const worktreePath = await createWorktree(state.cwd, options.worktreeName, this.reporter)
      state.worktreePath = worktreePath
      state.cwd = worktreePath
      await this.store.save(state)
    }

    state.status = "running"
    await this.store.save(state)

    // Progress report timer
    let progressTimer: ReturnType<typeof setInterval> | undefined
    if (options.progressReportIntervalMs > 0) {
      progressTimer = setInterval(async () => {
        try {
          const current = await this.store.load(state.id)
          if (current.status !== "running") return
          const report = await generateProgressReport(this.client, current, options)
          current.progressReports.push(report)
          await this.store.save(current)
          await this.store.saveProgressReport(state.id, report)
          this.reporter.progress?.(report)
          if (current.progressReports.length % 3 === 0) {
            const summary = await synthesizeProgressReport(this.client, current, options)
            await this.store.writeArtifact(state.id, `progress-${report.checkpoint}.md`, summary)
          }
        } catch {
          // Best-effort progress reporting
        }
      }, options.progressReportIntervalMs)
    }

    const plan = state.plan
    if (!plan) throw new Error("Workflow has no plan after planning step.")

    try {
      for (const phase of plan.phases) {
        state = await this.refreshControlState(state)
        if (state.status === "paused" || state.status === "aborted") break

        // Permission mode: plan approval per phase
        if (options.permissionMode === "plan") {
          this.reporter.info(`Phase ${phase.title} awaiting plan-mode approval`, { phaseId: phase.id })
        }

        await this.runPhase(state, phase, options)
        state = await this.store.load(state.id)
      }

      state = await this.store.load(state.id)
      if (state.status === "aborted" || state.status === "paused") {
        if (progressTimer) clearInterval(progressTimer)
        return state
      }

      const failedTasks = Object.values(state.tasks).filter((task) => task.status === "failed")
      const failedPhases = Object.values(state.phases).filter((phase) => phase.status === "failed")
      if (failedTasks.length || failedPhases.length) {
        state.status = "failed"
        state.error = `${failedTasks.length} task(s) and ${failedPhases.length} phase(s) failed.`
        await this.store.save(state)
        if (progressTimer) clearInterval(progressTimer)
        return state
      }

      const summary = await this.synthesize(state, options)
      state = await this.store.load(state.id)
      state.summary = summary
      state.summaryPath = await this.store.writeArtifact(state.id, "summary.md", summary)
      state.status = "completed"
      await this.store.save(state)
      await this.event(state.id, "workflow.completed", "Workflow completed", { summaryPath: state.summaryPath })
      if (progressTimer) clearInterval(progressTimer)

      // Save workflow template if requested
      if (options.saveWorkflow && options.workflowName) {
        state.isTemplate = true
        state.templateName = options.workflowName
        await this.store.saveWorkflowTemplate(state.id, options.workflowName, state)
      }

      // Cleanup worktree if used
      if (options.useWorktree && options.worktreeName) {
        await cleanupWorktree(options.cwd, options.worktreeName, this.reporter)
      }

      return state
    } catch (error) {
      state = await this.store.load(state.id)
      state.status = "failed"
      state.error = toErrorMessage(error)
      await this.store.save(state)
      await this.event(state.id, "workflow.failed", state.error)
      this.reporter.error("Workflow failed", { workflowId: state.id, error: state.error })
      if (progressTimer) clearInterval(progressTimer)
      return state
    }
  }

  async abort(workflowId: string): Promise<WorkflowState> {
    const state = await this.store.load(workflowId)
    state.status = "aborted"
    await Promise.all(state.sessions.map((sessionId) => this.client.abortSession(sessionId)))
    await this.store.save(state)
    await this.event(workflowId, "workflow.aborted", "Workflow aborted")
    return state
  }

  async pause(workflowId: string): Promise<WorkflowState> {
    const state = await this.store.load(workflowId)
    state.status = "paused"
    await this.store.save(state)
    await this.event(workflowId, "workflow.paused", "Workflow paused")
    return state
  }

  private async runPhase(state: WorkflowState, phase: WorkflowPhase, options: DynamicWorkflowOptions): Promise<void> {
    const existing = state.phases[phase.id]
    if (existing?.status === "completed") return
    this.ensurePhaseDependenciesComplete(state, phase)

    const phaseState: PhaseRunState = existing ?? { phaseId: phase.id, status: "pending", gateResults: [] }
    phaseState.status = "running"
    phaseState.startedAt ??= nowIso()
    state.phases[phase.id] = phaseState
    await this.store.save(state)
    await this.event(state.id, "phase.started", `Started phase ${phase.title}`, { phaseId: phase.id, tasks: phase.tasks.length })
    this.reporter.info(`Phase: ${phase.title}`, { phaseId: phase.id, tasks: phase.tasks.length })

    await this.runPhaseTasksWithDependencies(state, phase, options)

    state = await this.store.load(state.id)
    const phaseTasks = phase.tasks.map((task) => state.tasks[task.id]).filter(Boolean)
    const failed = phaseTasks.filter((task) => task.status === "failed")
    if (failed.length > 0 && options.failFast) {
      state.phases[phase.id].status = "failed"
      state.phases[phase.id].error = `${failed.length} task(s) failed.`
      await this.store.save(state)
      return
    }

    const gateResults = await this.runQualityGates(state, phase, options)
    state = await this.store.load(state.id)
    state.phases[phase.id].gateResults = gateResults
    const gateFailed = gateResults.some((gate) => gate.exitCode !== 0)
    state.phases[phase.id].status = gateFailed ? "failed" : "completed"
    state.phases[phase.id].completedAt = nowIso()
    if (gateFailed) state.phases[phase.id].error = "One or more quality gates failed."
    await this.store.save(state)
    await this.event(state.id, gateFailed ? "phase.failed" : "phase.completed", `${gateFailed ? "Failed" : "Completed"} phase ${phase.title}`, {
      phaseId: phase.id,
      gates: gateResults.length,
    })
  }

  private async runPhaseTasksWithDependencies(state: WorkflowState, phase: WorkflowPhase, options: DynamicWorkflowOptions): Promise<void> {
    let guard = 0
    while (guard++ < phase.tasks.length + 1) {
      state = await this.store.load(state.id)
      state = await this.refreshControlState(state)
      if (state.status === "paused" || state.status === "aborted") return

      const unfinished = phase.tasks.filter((task) => {
        const taskState = state.tasks[task.id]
        return taskState.status !== "completed" && taskState.status !== "failed" && taskState.status !== "skipped"
      })
      if (unfinished.length === 0) return

      const blockedByFailure = unfinished.filter((task) =>
        task.dependsOn.some((dep) => {
          const depState = state.tasks[dep]
          return !depState || depState.status === "failed" || depState.status === "skipped"
        }),
      )
      for (const task of blockedByFailure) {
        await this.failTask(state.id, task.id, `Dependency failed or is missing: ${task.dependsOn.join(", ")}`)
      }
      if (blockedByFailure.length) continue

      const runnable = unfinished.filter((task) =>
        task.dependsOn.every((dep) => state.tasks[dep]?.status === "completed"),
      )
      if (runnable.length === 0) {
        for (const task of unfinished) {
          await this.failTask(state.id, task.id, `Dependency cycle or unresolved dependency: ${task.dependsOn.join(", ")}`)
        }
        return
      }

      await mapLimit(runnable, options.concurrency, async (task) => {
        const current = await this.store.load(state.id)
        const controlled = await this.refreshControlState(current)
        if (controlled.status === "paused" || controlled.status === "aborted") return undefined
        return this.runTaskWithVerification(controlled, phase, task, options)
      })
    }

    const latest = await this.store.load(state.id)
    const stillUnfinished = phase.tasks.filter((task) => latest.tasks[task.id]?.status === "pending")
    for (const task of stillUnfinished) {
      await this.failTask(latest.id, task.id, "Task scheduler guard exhausted.")
    }
  }

  private async runTaskWithVerification(
    state: WorkflowState,
    phase: WorkflowPhase,
    task: AgentTask,
    options: DynamicWorkflowOptions,
  ): Promise<TaskRunState> {
    let taskState = state.tasks[task.id]
    if (this.isTaskComplete(taskState)) return taskState
    this.ensureTaskDependenciesComplete(state, task)

    // Apply skills/constraints to the task before execution
    const skills = resolveSkills(options.skills)
    const skilledTask = skills.length > 0 ? applySkillsToTask(task, skills, task.role) : task

    let followUp = ""
    const maxAttempts = Math.max(1, options.retryLimit + 1)
    for (let attemptNumber = taskState.attempts.length + 1; attemptNumber <= maxAttempts; attemptNumber++) {
      const attempt = await this.runWorkerAttempt(state, phase, skilledTask, options, attemptNumber, followUp)
      taskState = await this.recordAttempt(state.id, task.id, attempt)

      if (attempt.error) {
        if (attemptNumber >= maxAttempts) return this.failTask(state.id, task.id, attempt.error)
        followUp = `The previous attempt failed with: ${attempt.error}`
        continue
      }

      if (options.verificationRounds <= 0) {
        return this.completeTask(state.id, task.id, attempt.output ?? "", undefined)
      }

      const verification = await this.verifyTask(state.id, phase, skilledTask, attempt.output ?? "", options)
      taskState = await this.attachVerification(state.id, task.id, verification)

      // Adversarial review
      if (options.adversarialReview) {
        const convergence = await runAdversarialReview(
          this.client, phase, skilledTask, attempt.output ?? "", verification, options,
        )
        taskState = await this.attachConvergence(state.id, task.id, convergence)
        if (!convergence.converged || convergence.finalVerdict === "reject") {
          const followUp = `Adversarial review rejected this work. Issues: ${convergence.reviews.flatMap((r) => r.issues).join("; ")}`
          if (attemptNumber >= maxAttempts) {
            return this.failTask(state.id, task.id, `Adversarial review failed: ${followUp}`)
          }
          continue
        }
      }

      if (verification.pass) {
        return this.completeTask(state.id, task.id, attempt.output ?? "", verification)
      }

      followUp = verification.followUpPrompt || [
        "A verifier rejected the prior output.",
        `Issues: ${verification.issues.join("; ") || "unspecified"}`,
        "Revise the work and return new evidence.",
      ].join("\n")
      if (attemptNumber >= maxAttempts) {
        return this.failTask(state.id, task.id, `Verification failed: ${verification.issues.join("; ") || "no issue details"}`)
      }
    }
    return this.failTask(state.id, task.id, "Exhausted attempts.")
  }

  private async runWorkerAttempt(
    state: WorkflowState,
    phase: WorkflowPhase,
    task: AgentTask,
    options: DynamicWorkflowOptions,
    attemptNumber: number,
    followUp: string,
  ): Promise<TaskAttempt> {
    const startedAt = nowIso()
    const attempt: TaskAttempt = { attempt: attemptNumber, startedAt, tokensUsed: 0 }
    try {
      const sessionId = await this.client.createSession(`dw:${state.id}:${task.id}:attempt-${attemptNumber}`)
      attempt.sessionId = sessionId
      state.sessions.push(sessionId)
      state.tasks[task.id].status = "running"
      state.tasks[task.id].updatedAt = nowIso()
      await this.store.save(state)
      await this.client.initSession(sessionId)
      const model = resolveModel(task.role, task, options.models)
      attempt.model = model
      await this.client.prompt(sessionId, buildWorkerContext(state, phase, task), { noReply: true })
      const result = await this.client.prompt(sessionId, buildWorkerPrompt(task, attemptNumber, followUp), {
        model,
        agent: task.canEdit ? "build" : "explore",
      })
      attempt.output = result.text
      attempt.tokensUsed = estimateTokens(result.text) ?? 0
      attempt.completedAt = nowIso()
      await this.accumulateTokens(state.id, attempt.tokensUsed)
      await this.event(state.id, "task.attempt.completed", `Completed ${task.id} attempt ${attemptNumber}`, {
        taskId: task.id,
        sessionId,
        model,
        tokensUsed: attempt.tokensUsed,
      })
      if (options.cleanUpSessions) await this.client.deleteSession(sessionId)
      return attempt
    } catch (error) {
      attempt.error = toErrorMessage(error)
      attempt.completedAt = nowIso()
      await this.event(state.id, "task.attempt.failed", attempt.error, { taskId: task.id, attempt: attemptNumber })
      return attempt
    }
  }

  private async verifyTask(
    workflowId: string,
    phase: WorkflowPhase,
    task: AgentTask,
    output: string,
    options: DynamicWorkflowOptions,
  ): Promise<VerificationResult> {
    const sessionId = await this.client.createSession(`dw:${workflowId}:${task.id}:verify`)
    const state = await this.store.load(workflowId)
    state.sessions.push(sessionId)
    await this.store.save(state)
    await this.client.initSession(sessionId)
    const model = resolveModel("verifier", undefined, options.models)
    const result = await this.client.prompt(sessionId, buildVerifierPrompt(phase, task, output), {
      model,
      agent: "plan",
      format: jsonSchema(VERIFICATION_SCHEMA, 2),
    })
    const tokensUsed = estimateTokens(result.text)
    await this.accumulateTokens(workflowId, tokensUsed)
    if (options.cleanUpSessions) await this.client.deleteSession(sessionId)
    const structured = result.structured as Record<string, unknown> | undefined
    const verification = coerceVerification(structured, result.text)
    verification.tokensUsed = tokensUsed
    await this.event(workflowId, "task.verified", `Verified ${task.id}`, {
      taskId: task.id,
      pass: verification.pass,
      confidence: verification.confidence,
      tokensUsed,
    })
    return verification
  }

  private async runQualityGates(state: WorkflowState, phase: WorkflowPhase, options: DynamicWorkflowOptions): Promise<ShellResult[]> {
    const gates = phase.qualityGates.filter(Boolean)
    if (gates.length === 0) return []
    const results: ShellResult[] = []
    const sessionId = await this.client.createSession(`dw:${state.id}:${phase.id}:quality-gates`)
    state.sessions.push(sessionId)
    await this.store.save(state)
    await this.client.initSession(sessionId)
    let gateTokens = 0
    for (const command of gates) {
      const result = await this.client.shell(sessionId, command, options.qualityGateTimeoutMs)
      results.push(result)
      gateTokens += estimateTokens(result.stdout + result.stderr)
      await this.event(state.id, "quality-gate.completed", `Quality gate completed: ${command}`, {
        phaseId: phase.id,
        exitCode: result.exitCode,
      })
      if (result.exitCode !== 0 && options.failFast) break
    }
    await this.accumulateTokens(state.id, gateTokens)
    const latest = await this.store.load(state.id)
    if (latest.phases[phase.id]) {
      latest.phases[phase.id].tokensUsed = gateTokens
      await this.store.save(latest)
    }
    if (options.cleanUpSessions) await this.client.deleteSession(sessionId)
    return results
  }

  private async accumulateTokens(workflowId: string, tokens: number): Promise<void> {
    const safeTokens = Number.isFinite(tokens) && tokens >= 0 ? tokens : 0
    const state = await this.store.load(workflowId)
    state.totalTokensUsed += safeTokens
    await this.store.save(state)
  }

  private async attachConvergence(workflowId: string, taskId: string, convergence: import("./types.js").ConvergenceResult): Promise<TaskRunState> {
    const state = await this.store.load(workflowId)
    const taskState = state.tasks[taskId]
    taskState.convergence = convergence
    taskState.adversarialReviews = convergence.reviews
    taskState.updatedAt = nowIso()
    state.convergenceResults[taskId] = convergence
    await this.store.save(state)
    return taskState
  }

  private async synthesize(state: WorkflowState, options: DynamicWorkflowOptions): Promise<string> {
    const completedTasks = Object.values(state.tasks).filter((task) => task.status === "completed")
    const inputs = completedTasks.map((task) => {
      const attempt = task.attempts.at(-1)
      return [
        `## Agent ${task.taskId}`,
        `Phase: ${task.phaseId}`,
        `Verified: ${task.verified}`,
        task.verification ? `Verifier confidence: ${task.verification.confidence}` : "",
        "",
        truncate(attempt?.output ?? task.output ?? "", 4_000),
      ].join("\n")
    })

    let total = inputs.join("\n\n").length

    // Context offloading: if total exceeds threshold, offload intermediate results to cache
    let synthesisInputs = inputs
    if (total > options.contextOffloadThreshold && inputs.length > 1) {
      const offloadKey = `synthesis-context-${state.id}`
      await this.store.writeCachedResult(state.id, offloadKey, inputs.join("\n\n"))
      synthesisInputs = [
        `## Context offloaded`,
        `Total intermediate results: ${inputs.length} agents`,
        `Offloaded to cache key: ${offloadKey}`,
        `Load full context from cache if needed.`,
        inputs[0], // Keep first agent as sample
        inputs[inputs.length - 1], // Keep last agent as sample
      ]
    }

    const synthesisTotal = synthesisInputs.join("\n\n").length
    const chunkSize = synthesisTotal > options.maxSummaryInputChars ? 12 : Math.max(1, synthesisInputs.length)
    const chunks = chunkArray(synthesisInputs, chunkSize)
    const partials = await mapLimit(chunks, Math.min(options.concurrency, 4), async (chunk, index) => {
      const sessionId = await this.client.createSession(`dw:${state.id}:synthesis-chunk-${index + 1}`)
      const latest = await this.store.load(state.id)
      latest.sessions.push(sessionId)
      await this.store.save(latest)
      await this.client.initSession(sessionId)
      const model = resolveModel("synthesizer", undefined, options.models)
      const result = await this.client.prompt(sessionId, buildSynthesisPrompt(state, chunk.join("\n\n"), false), {
        model,
        agent: "plan",
      })
      if (options.cleanUpSessions) await this.client.deleteSession(sessionId)
      return result.text
    })

    const sessionId = await this.client.createSession(`dw:${state.id}:final-synthesis`)
    const latest = await this.store.load(state.id)
    latest.sessions.push(sessionId)
    await this.store.save(latest)
    await this.client.initSession(sessionId)
    const model = resolveModel("synthesizer", undefined, options.models)
    const result = await this.client.prompt(sessionId, buildSynthesisPrompt(state, partials.join("\n\n"), true), {
      model,
      agent: "plan",
    })
    if (options.cleanUpSessions) await this.client.deleteSession(sessionId)
    return result.text || partials.join("\n\n")
  }

  private async recordAttempt(workflowId: string, taskId: string, attempt: TaskAttempt): Promise<TaskRunState> {
    const state = await this.store.load(workflowId)
    const taskState = state.tasks[taskId]
    taskState.attempts.push(attempt)
    taskState.output = attempt.output ?? taskState.output
    taskState.status = attempt.error ? "failed" : "completed"
    taskState.updatedAt = nowIso()
    await this.store.save(state)
    return taskState
  }

  private async attachVerification(workflowId: string, taskId: string, verification: VerificationResult): Promise<TaskRunState> {
    const state = await this.store.load(workflowId)
    const taskState = state.tasks[taskId]
    const attempt = taskState.attempts.at(-1)
    if (attempt) attempt.verification = verification
    taskState.verification = verification
    taskState.verified = verification.pass
    taskState.updatedAt = nowIso()
    await this.store.save(state)
    return taskState
  }

  private async completeTask(workflowId: string, taskId: string, output: string, verification?: VerificationResult): Promise<TaskRunState> {
    const state = await this.store.load(workflowId)
    const taskState = state.tasks[taskId]
    taskState.status = "completed"
    taskState.output = output
    taskState.verified = verification ? verification.pass : true
    taskState.verification = verification
    taskState.updatedAt = nowIso()
    await this.store.save(state)
    return taskState
  }

  private async failTask(workflowId: string, taskId: string, error: string): Promise<TaskRunState> {
    const state = await this.store.load(workflowId)
    const taskState = state.tasks[taskId]
    taskState.status = "failed"
    taskState.updatedAt = nowIso()
    await this.store.save(state)
    await this.event(workflowId, "task.failed", error, { taskId })
    return taskState
  }

  private ensurePhaseDependenciesComplete(state: WorkflowState, phase: WorkflowPhase): void {
    for (const dep of phase.dependsOn) {
      const depState = state.phases[dep]
      if (!depState || depState.status !== "completed") {
        throw new Error(`Phase ${phase.id} depends on incomplete phase ${dep}.`)
      }
    }
  }

  private ensureTaskDependenciesComplete(state: WorkflowState, task: AgentTask): void {
    for (const dep of task.dependsOn) {
      const depState = state.tasks[dep]
      if (!depState || depState.status !== "completed") {
        throw new Error(`Task ${task.id} depends on incomplete task ${dep}.`)
      }
    }
  }

  private isTaskComplete(taskState: TaskRunState | undefined): boolean {
    return Boolean(taskState && taskState.status === "completed" && taskState.verified)
  }

  private async refreshControlState(state: WorkflowState): Promise<WorkflowState> {
    const latest = await this.store.load(state.id)
    if (latest.status === "paused" || latest.status === "aborted") return latest
    return state
  }

  private async event(workflowId: string, type: string, message: string, details?: Record<string, unknown>): Promise<void> {
    await this.store.appendEvent(workflowId, { time: nowIso(), type, message, details })
    await this.client.log(type.includes("failed") ? "error" : "info", message, { workflowId, type, ...details })
  }
}

function buildWorkerContext(state: WorkflowState, phase: WorkflowPhase, task: AgentTask): string {
  return [
    "You are an OpenCode dynamic workflow worker session.",
    `Workflow id: ${state.id}`,
    `Objective: ${state.objective}`,
    `Phase: ${phase.title} (${phase.id})`,
    `Phase strategy: ${phase.strategy}`,
    "",
    "Worker rules:",
    "- Stay within this task's scope.",
    "- Use OpenCode file and shell tools when needed.",
    "- If canEdit is false, do not write files.",
    "- Return concise evidence: files inspected/changed, commands run, findings, risks, and remaining gaps.",
    "- Do not claim validation passed unless you actually ran or inspected evidence for it.",
    "",
    `Task id: ${task.id}`,
    `Task title: ${task.title}`,
    `Can edit: ${task.canEdit}`,
    `Target files: ${task.targetFiles.join(", ") || "not specified"}`,
    `Expected artifacts: ${task.expectedArtifacts.join(", ") || "not specified"}`,
    `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- Address the task"}`,
  ].join("\n")
}

function buildWorkerPrompt(task: AgentTask, attemptNumber: number, followUp: string): string {
  return [
    `Run task ${task.id}, attempt ${attemptNumber}.`,
    "",
    task.prompt,
    "",
    followUp ? `Verifier or retry feedback:\n${followUp}\n` : "",
    "Finish with a structured prose result containing: Outcome, Evidence, Files, Commands, Risks, and Next steps.",
  ].join("\n")
}

function buildVerifierPrompt(phase: WorkflowPhase, task: AgentTask, output: string): string {
  return [
    "You are an independent verifier for an OpenCode dynamic workflow.",
    "Judge the worker output against the task only. Prefer false negatives over accepting unsupported claims.",
    "Use repository inspection or commands if necessary. Do not modify files.",
    "",
    `Phase verification strategy: ${phase.verification.strategy}`,
    `Task id: ${task.id}`,
    `Task title: ${task.title}`,
    `Task prompt:\n${task.prompt}`,
    "",
    `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- Address the task"}`,
    "",
    `Worker output:\n${truncate(output, 18_000)}`,
    "",
    "Return the structured verification result.",
  ].join("\n")
}

function buildSynthesisPrompt(state: WorkflowState, input: string, final: boolean): string {
  return [
    final ? "You are producing the final dynamic workflow report." : "You are summarizing a chunk of dynamic workflow agent results.",
    `Workflow id: ${state.id}`,
    `Objective: ${state.objective}`,
    "",
    "Requirements:",
    "- Cite agent ids for important claims.",
    "- Filter out unsupported or failed claims.",
    "- Separate completed work, verified findings, changed files, validation evidence, risks, and recommended next steps.",
    "- Be direct and do not include raw transcripts.",
    "",
    input,
  ].join("\n")
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function coerceVerification(value: Record<string, unknown> | undefined, rawText: string): VerificationResult {
  if (!value) {
    return {
      pass: /pass(ed)?|satisf/i.test(rawText) && !/fail(ed|ure)?|not satisfied/i.test(rawText),
      confidence: 0.4,
      issues: rawText ? [truncate(rawText, 800)] : ["Verifier did not return structured output."],
      evidence: [],
      rawText,
    }
  }
  const issues = Array.isArray(value.issues) ? value.issues.filter((item): item is string => typeof item === "string") : []
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter((item): item is string => typeof item === "string") : []
  const confidence = Number(value.confidence)
  return {
    pass: Boolean(value.pass),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    issues,
    evidence,
    followUpPrompt: typeof value.followUpPrompt === "string" ? value.followUpPrompt : undefined,
    rawText,
  }
}
