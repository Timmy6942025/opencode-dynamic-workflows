#!/usr/bin/env node
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { createWorkflowClient } from "./client.js"
import { installWorkflowCommand } from "./install.js"
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
    case "install-command":
      await installCommand(parsed)
      break
    case "help":
    default:
      printHelp()
      if (parsed.command !== "help") process.exitCode = 1
  }
}

async function runCommand(parsed: ParsedArgs): Promise<void> {
  const objective = parsed.positionals.join(" ").trim()
  if (!objective) throw new Error("Missing objective. Usage: ocdw run \"<objective>\"")
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

async function installCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = getStringFlag(parsed, "cwd") ?? process.cwd()
  const path = await installWorkflowCommand(cwd, Boolean(parsed.flags.global))
  if (parsed.flags.json) process.stdout.write(`${JSON.stringify({ path }, null, 2)}\n`)
  else process.stdout.write(`Installed OpenCode /workflow command at ${path}\n`)
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
  ocdw run "<objective>" [options]
  ocdw resume [workflow-id] [options]
  ocdw status [workflow-id] [--cwd .]
  ocdw list [--cwd .]
  ocdw pause [workflow-id] [--cwd .]
  ocdw abort [workflow-id] [--cwd .]
  ocdw install-command [--cwd .] [--global]

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
`)
}

main(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
