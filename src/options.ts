import { resolve } from "node:path"

import type { DynamicWorkflowOptions, ModelRouterConfig, WorkflowState } from "./types.js"

export function defaultWorkflowOptions(objective: string, cwd = process.cwd()): DynamicWorkflowOptions {
  return {
    objective,
    cwd: resolve(cwd),
    maxAgents: 1_000,
    concurrency: 16,
    verificationRounds: 1,
    retryLimit: 1,
    qualityGateTimeoutMs: 15 * 60 * 1000,
    cleanUpSessions: false,
    dryRun: false,
    failFast: true,
    maxSummaryInputChars: 60_000,
    models: {},
    orchestrationMode: "static",
    effortLevel: "high",
    permissionMode: "full",
    requireApproval: false,
    adversarialReview: false,
    convergenceThreshold: 0.75,
    generateOrchestrationScript: false,
    saveWorkflow: false,
    useWorktree: false,
    skills: [],
    contextOffloadThreshold: 200_000,
    progressReportIntervalMs: 60_000,
  }
}

export function optionsFromState(state: WorkflowState): DynamicWorkflowOptions {
  return {
    objective: state.objective,
    stoppingCondition: state.stoppingCondition,
    cwd: state.cwd,
    workflowId: state.id,
    maxAgents: state.options.maxAgents,
    concurrency: state.options.concurrency,
    verificationRounds: state.options.verificationRounds,
    retryLimit: state.options.retryLimit,
    qualityGateTimeoutMs: state.options.qualityGateTimeoutMs,
    cleanUpSessions: state.options.cleanUpSessions,
    dryRun: false,
    failFast: state.options.failFast,
    maxSummaryInputChars: state.options.maxSummaryInputChars,
    models: state.options.models,
    metadata: state.options.metadata,
    orchestrationMode: state.options.orchestrationMode,
    effortLevel: state.options.effortLevel,
    permissionMode: state.options.permissionMode,
    requireApproval: state.options.requireApproval,
    adversarialReview: state.options.adversarialReview,
    convergenceThreshold: state.options.convergenceThreshold,
    generateOrchestrationScript: state.options.generateOrchestrationScript,
    saveWorkflow: state.options.saveWorkflow,
    workflowName: state.options.workflowName,
    useWorktree: state.options.useWorktree,
    skills: state.options.skills,
    template: state.options.template,
    tokenBudget: state.options.tokenBudget,
    contextOffloadThreshold: state.options.contextOffloadThreshold,
    progressReportIntervalMs: state.options.progressReportIntervalMs,
  }
}

export function mergeModels(base: ModelRouterConfig, overrides: ModelRouterConfig): ModelRouterConfig {
  return Object.fromEntries(
    Object.entries({ ...base, ...overrides }).filter(([, value]) => typeof value === "string" && value.length > 0),
  )
}
