import type { DynamicWorkflowOptions, WorkflowSchedule, WorkflowState } from "./types.js"
import { FileWorkflowStore } from "./state.js"
import { createWorkflowId, nowIso } from "./util.js"

export function parseSchedule(expression: string, type: WorkflowSchedule["type"] = "cron", timezone?: string): WorkflowSchedule {
  return {
    type,
    expression,
    timezone,
  }
}

export function shouldRunNow(schedule: WorkflowSchedule): boolean {
  if (schedule.type === "once") {
    return !schedule.lastRun
  }
  if (schedule.type === "interval") {
    const intervalMs = parseIntervalMs(schedule.expression)
    if (!intervalMs) return false
    if (!schedule.lastRun) return true
    const lastRun = new Date(schedule.lastRun).getTime()
    return Date.now() - lastRun >= intervalMs
  }
  if (schedule.type === "cron") {
    // Basic cron-like check (simplified)
    const now = new Date()
    const parts = schedule.expression.split(" ")
    if (parts.length !== 5) return false
    const [minute, hour, day, month, weekday] = parts
    if (!matchCronField(minute, now.getMinutes())) return false
    if (!matchCronField(hour, now.getHours())) return false
    if (!matchCronField(day, now.getDate())) return false
    if (!matchCronField(month, now.getMonth() + 1)) return false
    if (!matchCronField(weekday, now.getDay())) return false
    return true
  }
  return false
}

function parseIntervalMs(expression: string): number | undefined {
  const match = expression.match(/^(\d+)\s*(s|m|h|d)$/)
  if (!match) return undefined
  const value = parseInt(match[1], 10)
  const unit = match[2]
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 }
  return value * (multipliers[unit] ?? 0)
}

function matchCronField(field: string, value: number): boolean {
  if (field === "*") return true
  if (field.includes(",")) {
    return field.split(",").some((part) => matchCronField(part.trim(), value))
  }
  if (field.includes("/")) {
    const [, step] = field.split("/")
    return value % parseInt(step, 10) === 0
  }
  if (field.includes("-")) {
    const [start, end] = field.split("-").map((s) => parseInt(s, 10))
    return value >= start && value <= end
  }
  return value === parseInt(field, 10)
}

export async function scheduleWorkflow(
  store: FileWorkflowStore,
  options: DynamicWorkflowOptions,
): Promise<WorkflowState> {
  if (!options.schedule) throw new Error("No schedule provided.")
  const state = await store.create(options)
  state.schedule = options.schedule
  state.status = "paused"
  await store.save(state)
  await store.appendEvent(state.id, {
    time: nowIso(),
    type: "workflow.scheduled",
    message: `Workflow scheduled with ${options.schedule.type} expression: ${options.schedule.expression}`,
  })
  return state
}

export async function updateScheduleLastRun(workflowId: string, store: FileWorkflowStore): Promise<void> {
  const state = await store.load(workflowId)
  if (state.schedule) {
    state.schedule.lastRun = nowIso()
    state.schedule.nextRun = computeNextRun(state.schedule)
    await store.save(state)
  }
}

function computeNextRun(schedule: WorkflowSchedule): string | undefined {
  if (schedule.type === "once") return undefined
  if (schedule.type === "interval") {
    const intervalMs = parseIntervalMs(schedule.expression)
    if (!intervalMs) return undefined
    return new Date(Date.now() + intervalMs).toISOString()
  }
  return computeNextCronTime(schedule.expression)
}

function computeNextCronTime(expression: string): string | undefined {
  const parts = expression.split(" ")
  if (parts.length !== 5) return undefined
  const [minuteField, hourField, dayField, monthField, weekdayField] = parts
  let next = new Date(Date.now() + 60_000)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      matchCronField(minuteField, next.getMinutes()) &&
      matchCronField(hourField, next.getHours()) &&
      matchCronField(dayField, next.getDate()) &&
      matchCronField(monthField, next.getMonth() + 1) &&
      matchCronField(weekdayField, next.getDay())
    ) {
      return next.toISOString()
    }
    next = new Date(next.getTime() + 60_000)
  }
  return undefined
}
