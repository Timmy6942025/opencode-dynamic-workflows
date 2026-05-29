#!/usr/bin/env node
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { createWorkflowClient } from "./client.js"
import { installWorkflowCommand, setupOpenCodePlugin } from "./install.js"
import { parseModelFlag } from "./model-router.js"
import { defaultWorkflowOptions, mergeModels, optionsFromState } from "./options.js"
import { ConsoleReporter } from "./reporter.js"
import { DynamicWorkflowRunner } from "./runner.js"
import { FileWorkflowStore } from "./state.js"
import type { DynamicWorkflowOptions, ModelRouterConfig, WorkflowState } from "./types.js"

interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Record<string, string | boolean | string[]>
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv.slice(2))
  switch (parsed.command) {
    case "run":
      await runCommand(parsed)
      break
    case "resume":
      await resumeCommand(parsed)
      break
    case "status":
      await statusCommand(parsed)
      break
    case "list":
      await listCommand(parsed)
      break
    case "abort":
      await abortCommand(parsed)
      break
    case "pause":
      await pauseCommand(parsed)
      break
    case "approve":
      await approveCommand(parsed)
      break
    case "reject":
      await rejectCommand(parsed)
      break
    case "templates":
      await templatesCommand(parsed)
      break
    case "skills":
      await skillsCommand(parsed)
      break
    case "dashboard":
      await dashboardCommand(parsed)
      break
    case "install-command":
      await installCommand(parsed)
      break
    case "setup":
      await setupCommand(parsed)
      break
    case "help":
    default:
      printHelp()
      if (parsed.command !== "help") process.exitCode = 1
  }
}

async function runCommand(parsed: ParsedArgs): Promise<void> {
  const objective = parsed.positionals.join(" ").trim()
  if (!objective) throw new Error("Missing objective. Usage: oc-dw run \"<objective>\"")
  const options = buildOptions(objective, parsed)
  const { runner, client } = await createRunner(options, Boolean(parsed.flags.json))
  try {
    const state = await runner.run(options)
    printStateResult(state, Boolean(parsed.flags.json))
  } finally {
    await client.close?.()
  }
}

async function resumeCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd()
  const store = new FileWorkflowStore(cwd)
  const existing = parsed.positionals[0] ? await store.load(parsed.positionals[0]) : await store.loadLatest()
  const options = buildResumeOptions(existing, parsed)
  const { runner, client } = await createRunner(options, Boolean(parsed.flags.json))
  try {
    const state = await runner.run(options)
    printStateResult(state, Boolean(parsed.flags.json))
  } finally {
    await client.close?.()
  }
}

async function statusCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd()
  const store = new FileWorkflowStore(cwd)
  const state = parsed.positionals[0] ? await store.load(parsed.positionals[0]) : await store.loadLatest()
  printStateResult(state, Boolean(parsed.flags.json), true)
}

async function listCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd()
  const store = new FileWorkflowStore(cwd)
  const states = await store.list()
  if (parsed.flags.json) {
    process.stdout.write(`${JSON.stringify(states, null, 2)}\n`)
    return
  }
  for (const state of states) {
    process.stdout.write(`${state.id}\t${state.status}\t${state.objective}\n`)
  }
}

async function abortCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd()
  const store = new FileWorkflowStore(cwd)
  const state = parsed.positionals[0] ? await store.load(parsed.positionals[0]) : await store.loadLatest()
  const options = buildOptions(state.objective, parsed)
  const { runner, client } = await createRunner(options, Boolean(parsed.flags.json))
  try {
    const updated = await runner.abort(state.id)
    printStateResult(updated, Boolean(parsed.flags.json))
  } finally {
    await client.close?.()
  }
}

async function pauseCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd()
  const store = new FileWorkflowStore(cwd)
  const state = parsed.positionals[0] ? await store.load(parsed.positionals[0]) : await store.loadLatest()
  const options = buildOptions(state.objective, parsed)
  const { runner, client } = await createRunner(options, Boolean(parsed.flags.json))
  try {
    const updated = await runner.pause(state.id)
    printStateResult(updated, Boolean(parsed.flags.json))
  } finally {
    await client.close?.()
  }
}

async function approveCommand(parsed: ParsedArgs): Promise<void> {
  const { approveWorkflow } = await import("./approval.js")
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd()
  const store = new FileWorkflowStore(cwd)
  const state = parsed.positionals[0] ? await store.load(parsed.positionals[0]) : await store.loadLatest()
  const updated = await approveWorkflow(state.id, store)
  printStateResult(updated, Boolean(parsed.flags.json))
}

async function rejectCommand(parsed: ParsedArgs): Promise<void> {
  const { rejectWorkflow } = await import("./approval.js")
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd()
  const store = new FileWorkflowStore(cwd)
  const state = parsed.positionals[0] ? await store.load(parsed.positionals[0]) : await store.loadLatest()
  const reason = getStringFlag(parsed, "reason")
  const updated = await rejectWorkflow(state.id, store, reason)
  printStateResult(updated, Boolean(parsed.flags.json))
}

async function templatesCommand(parsed: ParsedArgs): Promise<void> {
  const { listTemplates } = await import("./templates.js")
  const templates = listTemplates()
  if (parsed.flags.json) {
    process.stdout.write(`${JSON.stringify(templates, null, 2)}\n`)
    return
  }
  for (const t of templates) {
    process.stdout.write(`${t.id}\t[${t.category}]\t${t.name}\n  ${t.description}\n`)
  }
}

async function skillsCommand(parsed: ParsedArgs): Promise<void> {
  const { listSkills } = await import("./skills.js")
  const skills = listSkills()
  if (parsed.flags.json) {
    process.stdout.write(`${JSON.stringify(skills, null, 2)}\n`)
    return
  }
  for (const s of skills) {
    process.stdout.write(`${s.id}\t${s.name}\n  ${s.description}\n`)
  }
}

async function dashboardCommand(parsed: ParsedArgs): Promise<void> {
  const { startDashboardServer } = await import("./dashboard-server.js")
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd()
  const store = new FileWorkflowStore(cwd)
  const port = getNumberFlag(parsed, "port", 4097)
  const server = await startDashboardServer({ port, store })
  const url = `http://localhost:${port}`
  process.stdout.write(`Dashboard server running at ${url}\n`)
  process.stdout.write(`Press Ctrl+C to stop\n`)
  // Keep process alive until interrupted
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.close(() => resolve())
    })
    process.on("SIGTERM", () => {
      server.close(() => resolve())
    })
  })
}

async function installCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd()
  const path = await installWorkflowCommand(cwd, Boolean(parsed.flags.global))
  if (parsed.flags.json) process.stdout.write(`${JSON.stringify({ path }, null, 2)}\n`)
  else process.stdout.write(`Installed OpenCode /workflow command at ${path}\n`)
}

async function setupCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = resolve(getStringFlag(parsed, "cwd") ?? process.cwd())
  const global = Boolean(parsed.flags.global)
  const configPath = await setupOpenCodePlugin(cwd, global)
  if (parsed.flags.json) {
    process.stdout.write(`${JSON.stringify({ configPath, plugin: "oc-dw" }, null, 2)}\n`)
    return
  }
  process.stdout.write(`OpenCode plugin configured at ${configPath}\n`)
  process.stdout.write(`Plugin "oc-dw" added. Restart OpenCode to load the dynamic workflows plugin.\n`)
}

async function createRunner(options: DynamicWorkflowOptions, json: boolean) {
  const client = await createWorkflowClient({
    baseUrl: options.baseUrl,
    startServer: options.startServer,
    directory: options.cwd,
  })
  const store = new FileWorkflowStore(options.cwd)
  const runner = new DynamicWorkflowRunner(client, store, new ConsoleReporter(json))
  return { client, store, runner }
}

function buildOptions(objective: string, parsed: ParsedArgs): DynamicWorkflowOptions {
  const cwd = resolve(getStringFlag(parsed, "cwd") ?? process.cwd())
  const options = defaultWorkflowOptions(objective, cwd)
  options.baseUrl = getStringFlag(parsed, "base-url") ?? getStringFlag(parsed, "baseUrl")
  options.startServer = Boolean(parsed.flags["start-server"])
  options.dryRun = Boolean(parsed.flags["dry-run"])
  options.cleanUpSessions = Boolean(parsed.flags["cleanup"])
  options.failFast = !Boolean(parsed.flags["no-fail-fast"])
  options.maxAgents = getNumberFlag(parsed, "max-agents", options.maxAgents)
  options.concurrency = getNumberFlag(parsed, "concurrency", options.concurrency)
  options.verificationRounds = getNumberFlag(parsed, "verification-rounds", options.verificationRounds)
  options.retryLimit = getNumberFlag(parsed, "retry-limit", options.retryLimit)
  options.maxSummaryInputChars = getNumberFlag(parsed, "max-summary-input", options.maxSummaryInputChars)
  options.qualityGateTimeoutMs = getNumberFlag(parsed, "quality-gate-timeout-ms", options.qualityGateTimeoutMs)
  options.models = parseModels(parsed)

  // New options
  options.stoppingCondition = getStringFlag(parsed, "stopping-condition")
  const orchestrationMode = getStringFlag(parsed, "orchestration-mode")
  if (orchestrationMode === "static" || orchestrationMode === "dynamic") {
    options.orchestrationMode = orchestrationMode
  }
  const effortLevel = getStringFlag(parsed, "effort")
  if (effortLevel === "low" || effortLevel === "medium" || effortLevel === "high" || effortLevel === "ultra") {
    options.effortLevel = effortLevel
  }
  const permissionMode = getStringFlag(parsed, "permission-mode")
  if (permissionMode === "full" || permissionMode === "plan" || permissionMode === "ask") {
    options.permissionMode = permissionMode
  }
  options.requireApproval = Boolean(parsed.flags["require-approval"])
  options.adversarialReview = Boolean(parsed.flags["adversarial-review"])
  options.convergenceThreshold = getNumberFlag(parsed, "convergence-threshold", options.convergenceThreshold)
  options.generateOrchestrationScript = Boolean(parsed.flags["generate-orchestration-script"])
  options.saveWorkflow = Boolean(parsed.flags["save-workflow"])
  options.workflowName = getStringFlag(parsed, "workflow-name")
  options.useWorktree = Boolean(parsed.flags["use-worktree"])
  options.worktreeName = getStringFlag(parsed, "worktree-name")
  const tokenBudget = getNumberFlag(parsed, "token-budget", -1)
  if (tokenBudget >= 0) options.tokenBudget = tokenBudget
  options.contextOffloadThreshold = getNumberFlag(parsed, "context-offload-threshold", options.contextOffloadThreshold)
  options.progressReportIntervalMs = getNumberFlag(parsed, "progress-interval-ms", options.progressReportIntervalMs)

  const template = getStringFlag(parsed, "template")
  if (template) {
    options.template = template
  }

  const skills = getArrayFlag(parsed, "skill")
  if (skills.length) options.skills = skills

  if (parsed.flags["scout-first"]) options.scoutFirst = true
  const consensusModels = getStringFlag(parsed, "consensus-models")
  if (consensusModels) options.consensusModels = consensusModels.split(",").map((m) => m.trim())

  return options
}

function buildResumeOptions(existing: WorkflowState, parsed: ParsedArgs): DynamicWorkflowOptions {
  const options = optionsFromState(existing)
  options.workflowId = existing.id
  options.baseUrl = getStringFlag(parsed, "base-url") ?? getStringFlag(parsed, "baseUrl")
  options.startServer = Boolean(parsed.flags["start-server"])
  options.dryRun = false
  if (getStringFlag(parsed, "cwd")) options.cwd = resolve(getStringFlag(parsed, "cwd")!)
  if (parsed.flags.cleanup) options.cleanUpSessions = true
  if (parsed.flags["no-fail-fast"]) options.failFast = false
  options.maxAgents = getNumberFlag(parsed, "max-agents", options.maxAgents)
  options.concurrency = getNumberFlag(parsed, "concurrency", options.concurrency)
  options.verificationRounds = getNumberFlag(parsed, "verification-rounds", options.verificationRounds)
  options.retryLimit = getNumberFlag(parsed, "retry-limit", options.retryLimit)
  options.maxSummaryInputChars = getNumberFlag(parsed, "max-summary-input", options.maxSummaryInputChars)
  options.qualityGateTimeoutMs = getNumberFlag(parsed, "quality-gate-timeout-ms", options.qualityGateTimeoutMs)
  options.models = mergeModels(existing.options.models, parseModels(parsed))

  options.stoppingCondition = getStringFlag(parsed, "stopping-condition") ?? options.stoppingCondition
  const orchestrationMode = getStringFlag(parsed, "orchestration-mode")
  if (orchestrationMode === "static" || orchestrationMode === "dynamic") {
    options.orchestrationMode = orchestrationMode
  }
  const effortLevel = getStringFlag(parsed, "effort")
  if (effortLevel === "low" || effortLevel === "medium" || effortLevel === "high" || effortLevel === "ultra") {
    options.effortLevel = effortLevel
  }
  const permissionMode = getStringFlag(parsed, "permission-mode")
  if (permissionMode === "full" || permissionMode === "plan" || permissionMode === "ask") {
    options.permissionMode = permissionMode
  }
  if (parsed.flags["require-approval"]) options.requireApproval = true
  if (parsed.flags["adversarial-review"]) options.adversarialReview = true
  options.convergenceThreshold = getNumberFlag(parsed, "convergence-threshold", options.convergenceThreshold)
  if (parsed.flags["generate-orchestration-script"]) options.generateOrchestrationScript = true
  if (parsed.flags["save-workflow"]) options.saveWorkflow = true
  options.workflowName = getStringFlag(parsed, "workflow-name") ?? options.workflowName
  if (parsed.flags["use-worktree"]) options.useWorktree = true
  options.worktreeName = getStringFlag(parsed, "worktree-name") ?? options.worktreeName
  const tokenBudget = getNumberFlag(parsed, "token-budget", -1)
  if (tokenBudget >= 0) options.tokenBudget = tokenBudget
  options.contextOffloadThreshold = getNumberFlag(parsed, "context-offload-threshold", options.contextOffloadThreshold)
  options.progressReportIntervalMs = getNumberFlag(parsed, "progress-interval-ms", options.progressReportIntervalMs)
  const template = getStringFlag(parsed, "template")
  if (template) options.template = template
  const skills = getArrayFlag(parsed, "skill")
  if (skills.length) options.skills = skills

  if (parsed.flags["scout-first"]) options.scoutFirst = true
  const consensusModels = getStringFlag(parsed, "consensus-models")
  if (consensusModels) options.consensusModels = consensusModels.split(",").map((m) => m.trim())

  return options
}

function parseModels(parsed: ParsedArgs): ModelRouterConfig {
  let models: ModelRouterConfig = {}
  const direct: Record<string, string> = {
    default: "model",
    planner: "planner-model",
    worker: "worker-model",
    verifier: "verifier-model",
    synthesizer: "synthesizer-model",
    critic: "critic-model",
    scout: "scout-model",
  }
  for (const [role, flag] of Object.entries(direct)) {
    const value = getStringFlag(parsed, flag)
    if (value) models = { ...models, [role]: value }
  }
  const modelFlags = getArrayFlag(parsed, "model")
  for (const value of modelFlags) {
    const parsedModel = parseModelFlag(value)
    models = { ...models, [parsedModel.role]: parsedModel.model }
  }
  return models
}

function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "help"
  const rest = command === "help" ? args : args.slice(1)
  const flags: Record<string, string | boolean | string[]> = {}
  const positionals: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }
    const raw = arg.slice(2)
    const eq = raw.indexOf("=")
    const key = eq >= 0 ? raw.slice(0, eq) : raw
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined
    const value = inline ?? (rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true)
    if (key === "model") {
      const existing = flags[key]
      flags[key] = Array.isArray(existing) ? [...existing, String(value)] : [String(value)]
    } else {
      flags[key] = value
    }
  }
  return { command, positionals, flags }
}

function getStringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key]
  return typeof value === "string" ? value : undefined
}

function getArrayFlag(parsed: ParsedArgs, key: string): string[] {
  const value = parsed.flags[key]
  if (Array.isArray(value)) return value
  if (typeof value === "string") return [value]
  return []
}

function getNumberFlag(parsed: ParsedArgs, key: string, fallback: number): number {
  const raw = getStringFlag(parsed, key)
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`Invalid --${key} value "${raw}".`)
  return value
}

function printStateResult(state: WorkflowState, json: boolean, includeDetails = false): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`)
    return
  }
  const taskStates = Object.values(state.tasks)
  const completed = taskStates.filter((task) => task.status === "completed").length
  const failed = taskStates.filter((task) => task.status === "failed").length
  process.stdout.write(`Workflow ${state.id}\n`)
  process.stdout.write(`Status: ${state.status}\n`)
  process.stdout.write(`Objective: ${state.objective}\n`)
  process.stdout.write(`Tasks: ${completed}/${taskStates.length} completed, ${failed} failed\n`)
  if (state.summaryPath && existsSync(state.summaryPath)) process.stdout.write(`Summary: ${state.summaryPath}\n`)
  if (state.error) process.stdout.write(`Error: ${state.error}\n`)
  if (includeDetails && state.plan) {
    for (const phase of state.plan.phases) {
      const phaseState = state.phases[phase.id]
      process.stdout.write(`- ${phase.id}: ${phaseState?.status ?? "pending"} (${phase.tasks.length} tasks)\n`)
    }
  }
}

function printHelp(): void {
  process.stdout.write(`opencode-dynamic-workflows

Usage:
  oc-dw run "<objective>" [options]
  oc-dw resume [workflow-id] [options]
  oc-dw status [workflow-id] [--cwd .]
  oc-dw list [--cwd .]
  oc-dw pause [workflow-id] [--cwd .]
  oc-dw abort [workflow-id] [--cwd .]
  oc-dw approve [workflow-id] [--cwd .]
  oc-dw reject [workflow-id] [--cwd .] [--reason "..."]
  oc-dw templates [--json]
  oc-dw skills [--json]
  oc-dw dashboard [workflow-id] [--cwd .]
  oc-dw install-command [--cwd .] [--global]
  oc-dw setup [--global]

Options:
  --cwd <path>                      Project directory
  --base-url <url>                  OpenCode server URL (default http://localhost:4096)
  --start-server                    Start an OpenCode server through the SDK
  --concurrency <n>                 Concurrent OpenCode sessions (default 16)
  --max-agents <n>                  Max worker tasks in the plan (default 1000)
  --verification-rounds <n>         Verification sessions per task (default 1)
  --retry-limit <n>                 Retries after failed worker/verification (default 1)
  --model role=provider/model       Role model override
  --planner-model <provider/model>
  --worker-model <provider/model>
  --verifier-model <provider/model>
  --synthesizer-model <provider/model>
  --dry-run                         Plan and checkpoint without executing
  --cleanup                         Delete OpenCode sessions after collecting outputs
  --json                            Emit JSON logs/results

  --stopping-condition <text>     Explicit stopping condition / verifiable end state
  --effort <low|medium|high|ultra>  Effort level (default high)
  --permission-mode <full|plan|ask> Permission mode (default full)
  --require-approval                Require human approval before executing plan
  --adversarial-review            Enable adversarial review with convergence
  --convergence-threshold <n>       Adversarial convergence threshold 0-1 (default 0.75)
  --generate-orchestration-script   Generate dynamic orchestration script from plan
  --orchestration-mode <static|dynamic> Orchestration strategy (default static)
  --template <id>                 Use a built-in workflow template
  --skill <id>                      Apply a skill constraint (repeatable)
  --scout-first                     Run scout phase before planning (auto-enabled for high/ultra effort)
  --consensus-models <models>       Comma-separated verifier models for consensus (e.g., "openai/gpt-5.1-codex,anthropic/claude-sonnet-4-5")
  --save-workflow                   Save completed workflow as reusable template
  --workflow-name <name>            Name for saved workflow
  --use-worktree                    Run in a git worktree for isolation
  --worktree-name <name>            Name for the worktree
  --token-budget <n>                Maximum token budget for this workflow
  --context-offload-threshold <n>   Char threshold for context offloading (default 200000)
  --progress-interval-ms <n>        Progress report interval in ms (default 60000)
`)
}

main(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
