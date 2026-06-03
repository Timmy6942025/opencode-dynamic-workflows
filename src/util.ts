import { randomUUID } from "node:crypto"

import type { JsonSchemaFormat, PromptResult } from "./types.js"

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

interface PartLike {
  type?: string
  text?: string
  content?: string
}

interface MessageDataLike {
  parts?: PartLike[]
  text?: string
  message?: string
}

export function extractTextFromParts(value: unknown): string {
  const data = unwrapResponse<MessageDataLike>(value)
  const parts = Array.isArray(data?.parts) ? data.parts : Array.isArray(data) ? (data as unknown as PartLike[]) : []
  const text = parts
    .map((part) => {
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

interface StructuredOutputDataLike {
  info?: { structured_output?: unknown; structuredOutput?: unknown }
  structured_output?: unknown
  structuredOutput?: unknown
}

export function extractStructuredOutput(value: unknown): unknown {
  const data = unwrapResponse<StructuredOutputDataLike>(value)
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

export function jsonSchema(format: Record<string, unknown>, retryCount = 2): JsonSchemaFormat {
  return {
    type: "json_schema",
    schema: format,
    retryCount,
  }
}


export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
