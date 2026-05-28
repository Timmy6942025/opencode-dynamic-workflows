import type { AgentTask, ModelRole, ModelRouterConfig } from "./types.js"
import { isModelRole } from "./util.js"

export function resolveModel(role: ModelRole, task: Pick<AgentTask, "model" | "role"> | undefined, models: ModelRouterConfig): string | undefined {
  return task?.model ?? models[task?.role ?? role] ?? models[role] ?? models.default
}

export function parseModelFlag(value: string): { role: string; model: string } {
  const idx = value.indexOf("=")
  if (idx <= 0 || idx === value.length - 1) {
    throw new Error(`Invalid --model value "${value}". Expected role=provider/model.`)
  }
  const role = value.slice(0, idx)
  if (!isModelRole(role) && role !== "default") {
    throw new Error(`Invalid model role "${role}". Use default, planner, worker, verifier, synthesizer, critic, or scout.`)
  }
  return { role, model: value.slice(idx + 1) }
}

export function withModelOverride(models: ModelRouterConfig, role: string, model: string | undefined): ModelRouterConfig {
  if (!model) return models
  return { ...models, [role]: model }
}
