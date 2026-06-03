import type { ModelRole, ModelRouterConfig } from "./types.js"

export function resolveModel(role: ModelRole, task: Pick<{ model?: string; role: ModelRole }, "model" | "role"> | undefined, models: ModelRouterConfig): string | undefined {
  const taskModel = task?.model
  if (taskModel) return taskModel
  const roleModel = models[task?.role ?? role] ?? models[role] ?? models.default
  return typeof roleModel === "string" ? roleModel : undefined
}


