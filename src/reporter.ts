import type { Reporter, WorkflowState } from "./types.js"

export interface WorkflowSnapshot {
  workflowId: string
  objective: string
  status: string
  phases: PhaseSnapshot[]
  agents: AgentSnapshot[]
  logs: string[]
  currentPhase?: string
  currentTask?: string
  tokensUsed: number
  durationMs?: number
  result?: string
}

export interface PhaseSnapshot {
  id: string
  title: string
  status: string
  done: number
  total: number
  running: number
  errors: number
}

export interface AgentSnapshot {
  id: string
  label: string
  phase?: string
  status: AgentStatus
  resultPreview?: string
  error?: string
}

export type AgentStatus = "queued" | "running" | "done" | "error" | "skipped"

export class ConsoleReporter implements Reporter {
  constructor(private readonly json = false) {}

  info(message: string, details?: Record<string, unknown>): void {
    this.write("info", message, details)
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.write("warn", message, details)
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.write("error", message, details)
  }

  progress(report: import("./types.js").ProgressReport): void {
    if (this.json) {
      process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: "progress", report })}\n`)
      return
    }
    const pct = report.totalTasks > 0 ? Math.round((report.completedTasks / report.totalTasks) * 100) : 0
    process.stdout.write(
      `[progress] ${report.completedTasks}/${report.totalTasks} tasks, ${pct}% complete | tokens: ${report.tokensUsed}\n`,
    )
    if (report.blockers.length) {
      process.stdout.write(`  blockers: ${report.blockers.join("; ")}\n`)
    }
  }

  private write(level: string, message: string, details?: Record<string, unknown>): void {
    if (this.json) {
      process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, details })}\n`)
      return
    }
    const suffix = details ? ` ${JSON.stringify(details)}` : ""
    const line = `[${level}] ${message}${suffix}\n`
    if (level === "error") process.stderr.write(line)
    else process.stdout.write(line)
  }
}

export class SilentReporter implements Reporter {
  info(): void {}
  warn(): void {}
  error(): void {}
}

export function createWorkflowSnapshot(state: WorkflowState): WorkflowSnapshot {
  const phases: PhaseSnapshot[] = Object.values(state.phases).map((p) => {
    const phaseTasks = Object.values(state.tasks).filter((t) => t.phaseId === p.phaseId)
    return {
      id: p.phaseId,
      title: state.plan?.phases.find((ph) => ph.id === p.phaseId)?.title ?? p.phaseId,
      status: p.status,
      done: phaseTasks.filter((t) => t.status === "completed").length,
      total: phaseTasks.length,
      running: phaseTasks.filter((t) => t.status === "running").length,
      errors: phaseTasks.filter((t) => t.status === "failed").length,
    }
  })

  const agents: AgentSnapshot[] = Object.values(state.tasks).map((task, index) => {
    const attempt = task.attempts.at(-1)
    return {
      id: task.taskId,
      label: state.plan?.phases.flatMap((p) => p.tasks).find((t) => t.id === task.taskId)?.title ?? task.taskId,
      phase: task.phaseId,
      status: taskStatusToAgentStatus(task.status),
      resultPreview: attempt?.output ? shorten(attempt.output, 80) : undefined,
      error: attempt?.error ? shorten(attempt.error, 80) : undefined,
    }
  })

  const currentTask = Object.values(state.tasks).find((t) => t.status === "running")

  return {
    workflowId: state.id,
    objective: state.objective,
    status: state.status,
    phases,
    agents,
    logs: state.progressReports.map((r) => `${r.checkpoint}: ${r.completedTasks}/${r.totalTasks} tasks`),
    currentPhase: phases.find((p) => p.status === "running")?.title,
    currentTask: currentTask?.taskId,
    tokensUsed: state.totalTokensUsed,
  }
}

export function renderWorkflowText(snapshot: WorkflowSnapshot, completed = false): string {
  const header = completed ? "Workflow completed" : "Workflow running"
  const state =
    snapshot.agents.filter((a) => a.status === "error").length > 0
      ? `, ${snapshot.agents.filter((a) => a.status === "error").length} errors`
      : snapshot.agents.filter((a) => a.status === "running").length > 0
        ? `, ${snapshot.agents.filter((a) => a.status === "running").length} running`
        : ""
  const lines = [`◆ ${header}: ${snapshot.objective} (${snapshot.agents.filter((a) => a.status === "done").length}/${snapshot.agents.length} done${state})`]

  for (const phase of snapshot.phases) {
    const marker = phase.running > 0 || (phase.total > 0 && phase.done + phase.errors < phase.total && !completed) ? "▶" : phase.total > 0 && phase.done + phase.errors === phase.total ? "✓" : " "
    lines.push(
      ` ${marker} ${phase.title} ${phase.done}/${phase.total}${phase.running > 0 ? ` · ${phase.running} running` : ""}${phase.errors > 0 ? ` · ${phase.errors} errors` : ""}`,
    )
    const visibleAgents = snapshot.agents.filter((a) => a.phase === phase.id).slice(-4)
    for (const agent of visibleAgents) {
      const result = agent.resultPreview ? ` — ${agent.resultPreview}` : ""
      lines.push(`   #${agent.id} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${result}`)
    }
  }

  for (const log of snapshot.logs.slice(-2)) {
    lines.push(` log: ${log}`)
  }

  return lines.join("\n")
}

function taskStatusToAgentStatus(status: string): AgentStatus {
  switch (status) {
    case "pending":
      return "queued"
    case "running":
      return "running"
    case "completed":
      return "done"
    case "failed":
      return "error"
    case "skipped":
      return "skipped"
    default:
      return "queued"
  }
}

function statusIcon(status: AgentStatus): string {
  switch (status) {
    case "queued":
      return "○"
    case "running":
      return "●"
    case "done":
      return "✓"
    case "error":
      return "✗"
    case "skipped":
      return "-"
  }
}

function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (!text) return ""
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
