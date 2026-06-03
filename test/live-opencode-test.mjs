/**
 * Standalone live integration test that simulates what OpenCode does
 * when loading and using the oc-dw plugin end-to-end.
 *
 * Run with: node test/live-opencode-test.mjs
 *
 * This script:
 * 1. Imports the plugin module (simulating OpenCode's import("oc-dw"))
 * 2. Validates the PluginModule shape
 * 3. Calls server(ctx) with a realistic mock context
 * 4. Validates the Hooks and tool definition
 * 5. Calls tool.execute with a dry-run objective
 * 6. Verifies the full artifact chain was written to disk
 * 7. Validates state.json, plan.json, workflow-script.js, events.jsonl
 */

import { mkdtemp, rm, readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { strict as assert } from "node:assert"

const PASS = "✅"
const FAIL = "❌"
let passed = 0
let failed = 0

function check(condition, label) {
  if (condition) {
    console.log(`  ${PASS} ${label}`)
    passed++
  } else {
    console.log(`  ${FAIL} ${label}`)
    failed++
  }
}

async function cleanupDir(dir) {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Step 1: Import the plugin module (simulates OpenCode's import("oc-dw"))
// ---------------------------------------------------------------------------
console.log("\n🔌 Step 1: Import plugin module (simulating import('oc-dw'))")

const scriptDir = fileURLToPath(new URL(".", import.meta.url))
const distPath = join(scriptDir, "..", "dist", "src", "index.js")
const mod = await import(pathToFileURL(distPath).href)

check(mod.default, "default export exists")
check(typeof mod.default === "object", "default export is an object (V1 PluginModule format)")
check(typeof mod.default.server === "function", "default.server is a function")
check(typeof mod.plugin === "object", "named 'plugin' export exists (PluginModule)")
check(typeof mod.plugin.server === "function", "plugin.server is a function")
check(mod.default === mod.plugin, "default === named plugin")
check(typeof mod.DynamicWorkflowsPlugin === "function", "DynamicWorkflowsPlugin export exists")
check(mod.default.server === mod.DynamicWorkflowsPlugin, "default.server === DynamicWorkflowsPlugin")

// Verify all public exports
check(typeof mod.SdkLikeWorkflowClient === "function", "exports SdkLikeWorkflowClient")
check(typeof mod.DynamicWorkflowRunner === "function", "exports DynamicWorkflowRunner")
check(typeof mod.FileWorkflowStore === "function", "exports FileWorkflowStore")
check(typeof mod.WorkflowRuntime === "function", "exports WorkflowRuntime")
check(typeof mod.ScriptExecutor === "function", "exports ScriptExecutor")
check(typeof mod.installWorkflowCommand === "function", "exports installWorkflowCommand")
check(typeof mod.installUltraworkCommand === "function", "exports installUltraworkCommand")
check(typeof mod.setupOpenCodePlugin === "function", "exports setupOpenCodePlugin")

// ---------------------------------------------------------------------------
// Step 2: Call server(ctx) with a realistic mock context
// ---------------------------------------------------------------------------
console.log("\n🔧 Step 2: Initialize plugin (simulating OpenCode calling server(ctx))")

const cwd = await mkdtemp(join(tmpdir(), "oc-dw-live-test-"))
try {
  const logs = []
  const ctx = {
    directory: cwd,
    worktree: undefined,
    project: { name: "live-test-project" },
    serverUrl: new URL("http://localhost:3000"),
    client: {
      app: {
        log: async (opts) => logs.push(opts.body),
      },
      session: {
        create: async () => ({ data: { id: "live-session-1" } }),
        prompt: async () => ({ data: { parts: [{ type: "text", text: "mock response" }] } }),
        promptAsync: async () => ({ data: null }),
        messages: async () => ({ data: [{ role: "assistant", parts: [{ type: "text", text: "done" }] }] }),
        shell: async () => ({ data: { exitCode: 0, stdout: "ok", stderr: "" } }),
        delete: async () => ({ data: null }),
        abort: async () => ({ data: null }),
      },
    },
  }

  const hooks = await mod.default.server(ctx)

  check(hooks !== null && hooks !== undefined, "server() returns hooks")
  check(typeof hooks === "object", "hooks is an object")
  check(hooks.tool !== undefined, "hooks.tool exists")
  check(typeof hooks.tool === "object", "hooks.tool is an object")
  check(hooks.tool.dynamic_workflow_run !== undefined, "hooks.tool.dynamic_workflow_run exists")
  check(typeof hooks.tool.dynamic_workflow_run === "object", "tool definition is an object")
  check(typeof hooks.tool.dynamic_workflow_run.description === "string", "tool has description string")
  check(hooks.tool.dynamic_workflow_run.description.length > 50, "tool description is substantial (>50 chars)")
  check(typeof hooks.tool.dynamic_workflow_run.execute === "function", "tool has execute function")
  check(hooks.tool.dynamic_workflow_run.args !== undefined, "tool has args schema")
  check(hooks.tool.dynamic_workflow_run.args.objective !== undefined, "args.objective exists")
  check(typeof hooks.tool.dynamic_workflow_run.args.objective === "object", "args.objective is a Zod schema")

  // Verify initialization logging
  check(logs.length > 0, "plugin logged on initialization")
  check(logs.some(l => l.message.includes("oc-dw plugin loaded")), "logged 'oc-dw plugin loaded'")
  check(logs.some(l => l.level === "info"), "log level is info")

  // ---------------------------------------------------------------------------
  // Step 3: Execute tool with various argument patterns
  // ---------------------------------------------------------------------------
  console.log("\n🚀 Step 3: Execute tool (dry-run, simulating OpenCode tool invocation)")

  // 3a. Basic dry-run execution
  const dryResult = await hooks.tool.dynamic_workflow_run.execute({
    objective: "Create a README with project overview",
    dry_run: true,
    background: false,
  }, {})

  check(typeof dryResult === "string", "dry-run returns a string")
  check(dryResult.length > 20, "dry-run result is substantial")
  check(dryResult.includes(".opencode/dynamic-workflows/runs/"), "result references run directory")
  check(dryResult.toLowerCase().includes("planned") || dryResult.toLowerCase().includes("dry run"), "result indicates dry run")

  // 3b. Verify state file was written
  const runsDir = join(cwd, ".opencode", "dynamic-workflows", "runs")
  const runDirs = await readdir(runsDir)
  check(runDirs.length > 0, "created at least one run directory")

  const runDir = join(runsDir, runDirs[0])

  const stateRaw = await readFile(join(runDir, "state.json"), "utf8")
  const state = JSON.parse(stateRaw)
  check(state.id !== undefined, "state has id")
  check(state.status === "paused", "dry-run state is 'paused'")
  check(state.objective === "Create a README with project overview", "state stores objective")
  check(state.script !== undefined && state.script.length > 0, "state has generated script")
  check(state.plan !== undefined, "state has plan")
  check(state.plan.title !== undefined, "plan has title")
  check(state.plan.summary !== undefined, "plan has summary")
  check(state.plan.script !== undefined, "plan has script")
  check(typeof state.plan.maxAgentEstimate === "number", "plan has maxAgentEstimate")
  check(state.options !== undefined, "state has stored options")

  // 3c. Verify plan artifact
  const planRaw = await readFile(join(runDir, "plan.json"), "utf8")
  const plan = JSON.parse(planRaw)
  check(plan.title !== undefined, "plan artifact has title")
  check(typeof plan.title === "string" && plan.title.length > 0, "plan title is non-empty string")

  // 3d. Verify script artifact
  const scriptRaw = await readFile(join(runDir, "workflow-script.js"), "utf8")
  check(scriptRaw.length > 0, "script artifact has content")
  check(scriptRaw.includes("spawn") || scriptRaw.includes("wait") || scriptRaw.includes("log"), "script uses workflow API")

  // 3e. Verify events log
  const eventsRaw = await readFile(join(runDir, "events.jsonl"), "utf8")
  const events = eventsRaw.trim().split("\n").map(l => JSON.parse(l))
  check(events.length >= 2, "at least 2 events logged (created + planned)")
  check(events.some(e => e.type === "workflow.created"), "has workflow.created event")
  check(events.some(e => e.type === "workflow.planned"), "has workflow.planned event")
  check(events.every(e => typeof e.time === "string"), "all events have timestamps")
  check(events.every(e => typeof e.message === "string"), "all events have messages")

  // ---------------------------------------------------------------------------
  // Step 4: Execute with all optional arguments
  // ---------------------------------------------------------------------------
  console.log("\n⚙️  Step 4: Execute with all optional arguments")

  const fullResult = await hooks.tool.dynamic_workflow_run.execute({
    objective: "Refactor authentication module",
    stopping_condition: "All tests pass and no type errors",
    max_agents: 5,
    concurrency: 2,
    planner_model: "openai/gpt-5.1-codex",
    worker_model: "anthropic/claude-sonnet-4-5",
    verifier_model: "google/gemini-3-pro",
    synthesizer_model: "openai/gpt-5.1-codex",
    effort: "ultra",
    adversarial_review: true,
    template: "codebase-audit",
    skill: ["security-first", "strict-types"],
    token_budget: 100000,
    dry_run: true,
    background: false,
  }, {})

  check(typeof fullResult === "string", "full-options dry-run returns a string")
  check(fullResult.length > 0, "full-options result is non-empty")

  // ---------------------------------------------------------------------------
  // Step 5: Verify error handling
  // ---------------------------------------------------------------------------
  console.log("\n🛡️  Step 5: Verify error handling")

  // Null args
  try {
    await hooks.tool.dynamic_workflow_run.execute(null, {})
    check(false, "should reject null args")
  } catch (e) {
    check(e.message.includes("requires an object"), "rejects null args with clear message")
  }

  // Empty objective
  try {
    await hooks.tool.dynamic_workflow_run.execute({ objective: "" }, {})
    check(false, "should reject empty objective")
  } catch (e) {
    check(e.message.includes("non-empty objective"), "rejects empty objective with clear message")
  }

  // Missing objective
  try {
    await hooks.tool.dynamic_workflow_run.execute({}, {})
    check(false, "should reject missing objective")
  } catch (e) {
    check(e.message.includes("non-empty objective"), "rejects missing objective with clear message")
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log(`\n${"═".repeat(60)}`)
  console.log(`Live OpenCode Integration Test: ${passed} passed, ${failed} failed`)
  console.log(`${"═".repeat(60)}`)

  if (failed > 0) {
    process.exit(1)
  }

} finally {
  await cleanupDir(cwd)
}
