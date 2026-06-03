import { resolve } from "node:path"

import type { DynamicWorkflowOptions, WorkflowState } from "./types.js"

export function defaultWorkflowOptions(objective: string, cwd = process.cwd()): DynamicWorkflowOptions {
  return {
    objective,
    cwd: resolve(cwd),
    maxAgents: 1_000,
    concurrency: 16,
    cleanUpSessions: false,
    dryRun: false,
    models: {},
    effortLevel: "high",
    requireApproval: false,
    adversarialReview: false,
    saveWorkflow: false,
    useWorktree: false,
    skills: [],
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
    cleanUpSessions: state.options.cleanUpSessions,
    dryRun: false,
    models: state.options.models,
    metadata: state.options.metadata,
    effortLevel: state.options.effortLevel,
    requireApproval: state.options.requireApproval,
    adversarialReview: state.options.adversarialReview,
    saveWorkflow: state.options.saveWorkflow,
    workflowName: state.options.workflowName,
    useWorktree: state.options.useWorktree,
    skills: state.options.skills,
    template: state.options.template,
    consensusModels: state.options.consensusModels,
    tokenBudget: state.options.tokenBudget,
  }
}
