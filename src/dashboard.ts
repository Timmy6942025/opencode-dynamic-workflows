import { readFile } from "node:fs/promises"
import type { FileWorkflowStore } from "./state.js"
import type { ProgressReport, WorkflowState } from "./types.js"

export interface DashboardSnapshot {
  workflowId: string
  status: string
  objective: string
  progress: {
    completedTasks: number
    totalTasks: number
    completedPhases: number
    totalPhases: number
    percentComplete: number
  }
  currentPhase?: string
  currentTask?: string
  tokensUsed: number
  blockers: string[]
  recentEvents: Array<{ time: string; type: string; message: string }>
  lastUpdated: string
}

export async function buildSnapshot(store: FileWorkflowStore, workflowId: string): Promise<DashboardSnapshot | undefined> {
  try {
    const state = await store.load(workflowId)
    const taskStates = Object.values(state.tasks)
    const phaseStates = Object.values(state.phases)
    const completedTasks = taskStates.filter((t) => t.status === "completed").length
    const totalTasks = taskStates.length
    const completedPhases = phaseStates.filter((p) => p.status === "completed").length
    const totalPhases = phaseStates.length
    const percentComplete = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0

    const currentPhase = phaseStates.find((p) => p.status === "running")
    const currentTask = taskStates.find((t) => t.status === "running")

    const blockers: string[] = []
    if (state.error) blockers.push(state.error)
    for (const phase of phaseStates) {
      if (phase.status === "failed" && phase.error) blockers.push(phase.error)
    }
    for (const task of taskStates) {
      if (task.status === "failed" && task.attempts.length > 0) {
        const lastError = task.attempts.at(-1)?.error
        if (lastError) blockers.push(`${task.taskId}: ${lastError}`)
      }
    }

    // Read last few events
    let recentEvents: Array<{ time: string; type: string; message: string }> = []
    try {
      const eventsPath = store.eventsPath(workflowId)
      const raw = await readFile(eventsPath, "utf8")
      recentEvents = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-10)
        .map((line) => {
          try {
            const ev = JSON.parse(line)
            return { time: ev.time ?? "", type: ev.type ?? "", message: ev.message ?? "" }
          } catch {
            return { time: "", type: "", message: "" }
          }
        })
        .filter((ev) => ev.type)
    } catch {
      // No events file yet
    }

    return {
      workflowId: state.id,
      status: state.status,
      objective: state.objective,
      progress: {
        completedTasks,
        totalTasks,
        completedPhases,
        totalPhases,
        percentComplete,
      },
      currentPhase: currentPhase?.phaseId,
      currentTask: currentTask?.taskId,
      tokensUsed: state.totalTokensUsed,
      blockers: blockers.slice(0, 10),
      recentEvents,
      lastUpdated: state.updatedAt,
    }
  } catch {
    return undefined
  }
}

export function formatSnapshot(snapshot: DashboardSnapshot): string {
  const lines = [
    `┌─────────────────────────────────────────────────────────────┐`,
    `│  OpenCode Dynamic Workflow Dashboard                        │`,
    `├─────────────────────────────────────────────────────────────┤`,
    `│  Workflow: ${snapshot.workflowId.slice(0, 40).padEnd(41)}│`,
    `│  Status:   ${snapshot.status.padEnd(41)}│`,
    `│  Objective: ${snapshot.objective.slice(0, 40).padEnd(41)}│`,
    `├─────────────────────────────────────────────────────────────┤`,
    `│  Progress: ${snapshot.progress.completedTasks}/${snapshot.progress.totalTasks} tasks, ${snapshot.progress.completedPhases}/${snapshot.progress.totalPhases} phases │`,
    `│  ${snapshot.progress.percentComplete}% complete${" ".repeat(51 - String(snapshot.progress.percentComplete).length)}│`,
    `│  Tokens: ${String(snapshot.tokensUsed).padEnd(49)}│`,
  ]

  if (snapshot.currentPhase) {
    lines.push(`│  Current phase: ${snapshot.currentPhase.padEnd(39)}│`)
  }
  if (snapshot.currentTask) {
    lines.push(`│  Current task:  ${snapshot.currentTask.padEnd(39)}│`)
  }

  if (snapshot.blockers.length > 0) {
    lines.push(`├─────────────────────────────────────────────────────────────┤`)
    lines.push(`│  Blockers:`)
    for (const blocker of snapshot.blockers.slice(0, 5)) {
      lines.push(`│    - ${blocker.slice(0, 54).padEnd(54)}│`)
    }
  }

  if (snapshot.recentEvents.length > 0) {
    lines.push(`├─────────────────────────────────────────────────────────────┤`)
    lines.push(`│  Recent events:`)
    for (const ev of snapshot.recentEvents.slice(-5)) {
      const msg = `${ev.type}: ${ev.message}`.slice(0, 54)
      lines.push(`│    ${msg.padEnd(56)}│`)
    }
  }

  lines.push(`└─────────────────────────────────────────────────────────────┘`)
  return lines.join("\n")
}
