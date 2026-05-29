import type { AdversarialReview, AgentTask, ConvergenceResult, DynamicWorkflowOptions, ModelRole, VerificationResult, WorkflowClient, WorkflowPhase } from "./types.js"
import { resolveModel } from "./model-router.js"
import { jsonSchema, nowIso, truncate } from "./util.js"

const ADVERSARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["refute", "support", "neutral"], description: "Your adversarial verdict on the work." },
    confidence: { type: "number", description: "Confidence from 0 to 1." },
    issues: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "confidence", "issues", "evidence"],
}

export async function runAdversarialReview(
  client: WorkflowClient,
  phase: WorkflowPhase,
  task: AgentTask,
  output: string,
  verification: VerificationResult,
  options: DynamicWorkflowOptions,
): Promise<ConvergenceResult> {
  const adversaryRoles: ModelRole[] = ["critic", "adversary"]
  const reviews: AdversarialReview[] = []

  for (const role of adversaryRoles) {
    const review = await runAdversarySession(client, role, phase, task, output, verification, options)
    if (review) reviews.push(review)
  }

  return evaluateConvergence(reviews, options.convergenceThreshold)
}

async function runAdversarySession(
  client: WorkflowClient,
  role: ModelRole,
  phase: WorkflowPhase,
  task: AgentTask,
  output: string,
  verification: VerificationResult,
  options: DynamicWorkflowOptions,
): Promise<AdversarialReview | undefined> {
  const sessionId = await client.createSession(`dw:adversary:${role}:${task.id}`)
  try {
    await client.initSession(sessionId)
    const model = resolveModel(role, undefined, options.models)
    const result = await client.prompt(
      sessionId,
      buildAdversaryPrompt(role, phase, task, output, verification),
      { model, agent: "explore", format: jsonSchema(ADVERSARY_SCHEMA, 2) },
    )
    if (options.cleanUpSessions) await client.deleteSession(sessionId)

    const structured = result.structured as Record<string, unknown> | undefined
    if (!structured) return undefined

    const confidence = Number(structured.confidence)
    return {
      reviewerId: sessionId,
      reviewerRole: role,
      verdict: String(structured.verdict) as "refute" | "support" | "neutral",
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      issues: Array.isArray(structured.issues) ? structured.issues.filter((i): i is string => typeof i === "string") : [],
      evidence: Array.isArray(structured.evidence) ? structured.evidence.filter((i): i is string => typeof i === "string") : [],
      rawText: result.text,
      tokensUsed: estimateTokens(result.text),
    }
  } catch {
    if (options.cleanUpSessions) {
      try { await client.deleteSession(sessionId) } catch {}
    }
    return undefined
  }
}

function buildAdversaryPrompt(role: ModelRole, phase: WorkflowPhase, task: AgentTask, output: string, verification: VerificationResult): string {
  const directive = role === "critic"
    ? "You are a code critic. Your job is to find flaws, missing edge cases, or incorrect assumptions in the work. Be thorough and skeptical."
    : "You are an adversarial reviewer. Your job is to actively try to BREAK or REFUTE the claims and work produced. Look for hallucinations, unsupported claims, and logical errors."

  return [
    directive,
    "",
    `Phase: ${phase.title} (${phase.id})`,
    `Task: ${task.title} (${task.id})`,
    `Original prompt: ${task.prompt}`,
    `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- Address the task"}`,
    "",
    `Worker output:\n${truncate(output, 12_000)}`,
    "",
    `Primary verifier result: ${verification.pass ? "PASS" : "FAIL"} (confidence: ${verification.confidence})`,
    `Verifier issues: ${verification.issues.join("; ") || "none"}`,
    `Verifier evidence: ${verification.evidence.join("; ") || "none"}`,
    "",
    "Respond with your structured adversarial verdict. Be honest — if the work is solid, say so. If it has flaws, name them precisely.",
  ].join("\n")
}

function evaluateConvergence(reviews: AdversarialReview[], threshold: number): ConvergenceResult {
  if (reviews.length === 0) {
    return { converged: false, consensusConfidence: 0, reviews: [], finalVerdict: "needs_work", iterations: 0 }
  }

  const refutes = reviews.filter((r) => r.verdict === "refute")
  const supports = reviews.filter((r) => r.verdict === "support")

  // Unanimous support
  if (refutes.length === 0 && supports.length > 0) {
    const avgConfidence = supports.reduce((sum, r) => sum + r.confidence, 0) / supports.length
    return { converged: true, consensusConfidence: avgConfidence, reviews, finalVerdict: "accept", iterations: 1 }
  }

  // Unanimous refute
  if (supports.length === 0 && refutes.length > 0) {
    const avgConfidence = refutes.reduce((sum, r) => sum + r.confidence, 0) / refutes.length
    return { converged: true, consensusConfidence: avgConfidence, reviews, finalVerdict: "reject", iterations: 1 }
  }

  // Mixed: compare average confidences
  const supportConfidence = supports.reduce((sum, r) => sum + r.confidence, 0) / (supports.length || 1)
  const refuteConfidence = refutes.reduce((sum, r) => sum + r.confidence, 0) / (refutes.length || 1)
  const diff = supportConfidence - refuteConfidence

  if (diff >= threshold) {
    return { converged: true, consensusConfidence: supportConfidence, reviews, finalVerdict: "accept", iterations: 1 }
  }
  if (diff <= -threshold) {
    return { converged: true, consensusConfidence: refuteConfidence, reviews, finalVerdict: "reject", iterations: 1 }
  }

  return { converged: false, consensusConfidence: Math.max(supportConfidence, refuteConfidence), reviews, finalVerdict: "needs_work", iterations: 1 }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
