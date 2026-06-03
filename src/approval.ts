import { stat } from "node:fs/promises"

import type { DynamicWorkflowOptions, Reporter, WorkflowPlan, WorkflowState } from "./types.js"
import { FileWorkflowStore } from "./state.js"
import { nowIso } from "./util.js"

export async function requestApproval(
  state: WorkflowState,
  plan: WorkflowPlan,
  options: DynamicWorkflowOptions,
  reporter: Reporter,
  store: FileWorkflowStore,
): Promise<"approved" | "rejected" | "modified"> {
  if (!options.requireApproval) return "approved"

  state.status = "plan_approval"
  await store.save(state)

  const preview = formatPlanPreview(plan, options)
  reporter.info("Workflow plan requires approval", { workflowId: state.id, preview })

  await store.appendEvent(state.id, {
    time: nowIso(),
    type: "workflow.awaiting_approval",
    message: "Workflow plan awaiting human approval",
    details: { planTitle: plan.title, estimatedAgents: plan.maxAgentEstimate, estimatedTokens: plan.estimatedTokens },
  })

  // Write approval artifact for external tools to inspect
  await store.writeArtifact(
    state.id,
    "approval-request.md",
    `# Workflow Approval Request\n\n${preview}\n\nTo approve, set the workflow status to "running" in state.json or use \\"oc-dw approve ${state.id}\\".\n`,
  )

  // Poll for external approval by checking if state.status was changed from "plan_approval"
  const maxWaitMs = 300_000 // 5 minute timeout
  const pollIntervalMs = 5_000
  const start = Date.now()
  let lastMtime = 0

  while (Date.now() - start < maxWaitMs) {
    try {
      const s = await stat(store.statePath(state.id))
      if (s.mtimeMs <= lastMtime) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
        continue
      }
      lastMtime = s.mtimeMs
    } catch {
      // state file not readable yet
    }
    const current = await store.load(state.id)
    if (current.status === "running") return "approved"
    if (current.status === "aborted") return "rejected"
    if (current.status !== "plan_approval") return "modified"
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  throw new Error(`Workflow approval timed out after ${maxWaitMs}ms. Use "oc-dw approve ${state.id}" to approve or "oc-dw reject ${state.id}" to reject.`)
}

export function formatPlanPreview(plan: WorkflowPlan, options: DynamicWorkflowOptions): string {
  const lines = [
    `## Workflow Plan: ${plan.title}`,
    "",
    plan.summary,
    "",
    `Estimated agents: ${plan.maxAgentEstimate}`,
    `Estimated tokens: ${plan.estimatedTokens ?? "unknown"}`,
    `Estimated cost: ${plan.estimatedCost ?? "unknown"}`,
    `Concurrency: ${options.concurrency}`,
    `Adversarial review: ${options.adversarialReview ? "enabled" : "disabled"}`,
    "",
    "### Generated Workflow Script",
    "```javascript",
    plan.script.slice(0, 2000),
    plan.script.length > 2000 ? "// ... (truncated)" : "",
    "```",
    "",
    "---",
    "Approve to proceed, or reject to cancel.",
  ]
  return lines.join("\n")
}

export async function approveWorkflow(workflowId: string, store: FileWorkflowStore): Promise<WorkflowState> {
  const state = await store.load(workflowId)
  if (state.status !== "plan_approval") {
    throw new Error(`Workflow ${workflowId} is not awaiting approval (status: ${state.status}).`)
  }
  state.status = "running"
  await store.save(state)
  await store.appendEvent(workflowId, {
    time: nowIso(),
    type: "workflow.approved",
    message: "Workflow plan approved",
  })
  return state
}

export async function rejectWorkflow(workflowId: string, store: FileWorkflowStore, reason?: string): Promise<WorkflowState> {
  const state = await store.load(workflowId)
  if (state.status !== "plan_approval") {
    throw new Error(`Workflow ${workflowId} is not awaiting approval (status: ${state.status}).`)
  }
  state.status = "aborted"
  state.error = reason ?? "Workflow rejected by user"
  await store.save(state)
  await store.appendEvent(workflowId, {
    time: nowIso(),
    type: "workflow.rejected",
    message: state.error,
  })
  return state
}
