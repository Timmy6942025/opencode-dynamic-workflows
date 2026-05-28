import { createHash, randomUUID } from "node:crypto"

import type { JsonSchemaFormat, ModelRole, PromptResult } from "./types.js"

export function nowIso(): string {
  return new Date().toISOString()
}

export function createWorkflowId(objective: string): string {
  const slug = slugify(objective).slice(0, 40) || "workflow"
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}-${randomUUID().slice(0, 8)}`
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function stableId(prefix: string, input: string): string {
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 12)
  return `${prefix}-${hash}`
}

export function splitModelId(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const idx = model.indexOf("/")
  if (idx <= 0 || idx === model.length - 1) {
    throw new Error(`Invalid OpenCode model id "${model}". Expected provider/model-id.`)
  }
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) }
}

export function unwrapResponse<T = unknown>(response: unknown): T {
  if (response && typeof response === "object" && "data" in response) {
    return (response as { data: T }).data
  }
  return response as T
}

export function extractTextFromParts(value: unknown): string {
  const data = unwrapResponse<any>(value)
  const parts = Array.isArray(data?.parts) ? data.parts : Array.isArray(data) ? data : []
  const text = parts
    .map((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text
      if (typeof part?.text === "string") return part.text
      if (typeof part?.content === "string") return part.content
      return ""
    })
    .filter(Boolean)
    .join("\n")
  if (text) return text
  if (typeof data?.text === "string") return data.text
  if (typeof data?.message === "string") return data.message
  return ""
}

export function extractStructuredOutput(value: unknown): unknown {
  const data = unwrapResponse<any>(value)
  return (
    data?.info?.structured_output ??
    data?.info?.structuredOutput ??
    data?.structured_output ??
    data?.structuredOutput
  )
}

export function promptResultFromRaw(raw: unknown): PromptResult {
  return {
    text: extractTextFromParts(raw),
    structured: extractStructuredOutput(raw),
    raw,
  }
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n\n[truncated ${value.length - maxChars} chars]`
}

export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const safeLimit = Math.max(1, Math.floor(limit))
  const results = new Array<R>(items.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }

  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

export function jsonSchema(format: Record<string, unknown>, retryCount = 2): JsonSchemaFormat {
  return {
    type: "json_schema",
    schema: format,
    retryCount,
  }
}

export function isModelRole(value: string): value is ModelRole {
  return ["planner", "worker", "verifier", "synthesizer", "critic", "scout"].includes(value)
}

export function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
  if (typeof value === "string" && value.trim()) return [value]
  return []
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
