import type { DynamicWorkflowOptions, ProgressReport, WorkflowClient, WorkflowState } from "./types.js"
import { nowIso } from "./util.js"
import { resolveModel } from "./model-router.js"

export async function generateProgressReport(
  client: WorkflowClient,
  state: WorkflowState,
  options: DynamicWorkflowOptions,
  checkpoint?: string,
): Promise<ProgressReport> {
  const taskStates = Object.values(state.tasks)
  const phaseStates = Object.values(state.phases)
  const completedTasks = taskStates.filter((t) => t.status === "completed").length
  const failedTasks = taskStates.filter((t) => t.status === "failed").length
  const completedPhases = phaseStates.filter((p) => p.status === "completed").length

  const currentPhase = phaseStates.find((p) => p.status === "running")
  const currentTask = taskStates.find((t) => t.status === "running")

  const verifiedEvidence = taskStates
    .filter((t) => t.verified && t.verification)
    .flatMap((t) => t.verification?.evidence ?? [])
    .slice(0, 20)

  const remainingWork = state.plan?.phases
    .filter((p) => state.phases[p.id]?.status !== "completed")
    .map((p) => p.title) ?? []

  const blockers: string[] = []
  if (failedTasks > 0) blockers.push(`${failedTasks} task(s) failed`)
  if (state.error) blockers.push(state.error)
  for (const phase of phaseStates) {
    if (phase.status === "failed" && phase.error) blockers.push(phase.error)
  }

  const totalTokens = taskStates.reduce((sum, t) => sum + t.tokensUsed, 0)
    + phaseStates.reduce((sum, p) => sum + p.tokensUsed, 0)

  const report: ProgressReport = {
    checkpoint: checkpoint ?? `checkpoint-${Date.now()}`,
    time: nowIso(),
    completedTasks,
    totalTasks: taskStates.length,
    completedPhases,
    totalPhases: phaseStates.length,
    currentPhase: currentPhase?.phaseId,
    currentTask: currentTask?.taskId,
    verifiedEvidence,
    remainingWork,
    blockers,
    tokensUsed: totalTokens,
  }

  return report
}

export async function synthesizeProgressReport(
  client: WorkflowClient,
  state: WorkflowState,
  options: DynamicWorkflowOptions,
): Promise<string> {
  const sessionId = await client.createSession(`dw:${state.id}:progress-report`)
  try {
    await client.initSession(sessionId)
    const model = resolveModel("synthesizer", undefined, options.models)
    const taskStates = Object.values(state.tasks)
    const completed = taskStates.filter((t) => t.status === "completed").length
    const failed = taskStates.filter((t) => t.status === "failed").length
    const total = taskStates.length

    const prompt = [
      "You are generating a human-readable progress report for an OpenCode dynamic workflow.",
      "",
      `Workflow: ${state.id}`,
      `Objective: ${state.objective}`,
      `Status: ${state.status}`,
      `Progress: ${completed}/${total} tasks completed, ${failed} failed`,
      `Total tokens used: ${state.totalTokensUsed}`,
      "",
      "Recent events:",
      ...state.progressReports.slice(-3).map((r) =>
        `- ${r.checkpoint}: ${r.completedTasks}/${r.totalTasks} tasks, ${r.blockers.length} blockers`,
      ),
      "",
      "Generate a concise, professional progress report in markdown. Include:",
      "1. Overall status summary",
      "2. What has been completed",
      "3. Current work in progress",
      "4. Remaining work",
      "5. Blockers or risks",
      "6. Estimated completion (if determinable)",
    ].join("\n")

    const result = await client.prompt(sessionId, prompt, { model, agent: "plan" })
    if (options.cleanUpSessions) await client.deleteSession(sessionId)
    return result.text
  } catch {
    if (options.cleanUpSessions) {
      try { await client.deleteSession(sessionId) } catch {}
    }
    return `Progress: ${Object.values(state.tasks).filter((t) => t.status === "completed").length}/${Object.values(state.tasks).length} tasks completed.`
  }
}
