import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import plugin from "../src/plugin.js"
import { DynamicWorkflowsPlugin } from "../src/plugin.js"

/** Robust cleanup that retries on ENOTEMPTY (background workflows may still be writing). */
async function cleanupDir(dir: string, retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}

function createMockCtx(cwd: string) {
  const logs: Array<{ level: string; message: string }> = []
  return {
    directory: cwd,
    worktree: undefined as string | undefined,
    project: { name: "test-project" },
    serverUrl: new URL("http://localhost:3000"),
    client: {
      app: {
        log: async (opts: { body: { level: string; message: string } }) => {
          logs.push(opts.body)
        },
      },
      session: {
        create: async () => ({ data: { id: "mock-session-1" } }),
        prompt: async () => ({
          data: {
            parts: [{ type: "text", text: "mock response" }],
          },
        }),
        promptAsync: async () => ({ data: null }),
        messages: async () => ({
          data: [{ role: "assistant", parts: [{ type: "text", text: "done" }] }],
        }),
        shell: async () => ({ data: { exitCode: 0, stdout: "ok", stderr: "" } }),
        delete: async () => ({ data: null }),
        abort: async () => ({ data: null }),
      },
    },
    logs,
  }
}

/** Helper: parse a Zod schema value, catching Zod errors. Works regardless of Zod version type defs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function zParse(schema: any, value: unknown): { success: true } | { success: false; error: unknown } {
  try {
    schema.parse(value)
    return { success: true }
  } catch (error) {
    return { success: false, error }
  }
}

// ---------------------------------------------------------------------------
// PluginModule shape tests
// ---------------------------------------------------------------------------

test("PluginModule export shape matches OpenCode expectations", () => {
  assert.ok(plugin, "default export should exist")
  assert.equal(typeof plugin, "object", "default export should be an object (PluginModule)")
  assert.equal(typeof plugin.server, "function", "PluginModule.server should be a function")

  assert.equal(typeof DynamicWorkflowsPlugin, "function", "DynamicWorkflowsPlugin should be a function")
  assert.equal(plugin.server, DynamicWorkflowsPlugin, "server should point to the plugin function")
})

test("Plugin initializes and returns Hooks with tool definition", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)

    assert.ok(hooks, "plugin should return hooks")
    assert.ok(hooks.tool, "hooks should have a tool property")
    assert.ok(hooks.tool!.dynamic_workflow_run, "should register dynamic_workflow_run tool")

    const toolDef = hooks.tool!.dynamic_workflow_run
    assert.ok(toolDef.description, "tool should have a description")
    assert.ok(toolDef.description.includes("dynamic workflow"), "description should mention workflow")
    assert.equal(typeof toolDef.execute, "function", "tool should have an execute function")
    assert.ok(toolDef.args, "tool should have args schema")
  } finally {
    await cleanupDir(cwd)
  }
})

// ---------------------------------------------------------------------------
// Plugin lifecycle tests
// ---------------------------------------------------------------------------

test("Plugin logs initialization message on load", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    await plugin.server(ctx as any)

    assert.ok(ctx.logs.length > 0, "should log on initialization")
    assert.ok(
      ctx.logs.some((l) => l.message.includes("oc-dw plugin loaded")),
      "should log plugin loaded message",
    )
  } finally {
    await cleanupDir(cwd)
  }
})

test("Plugin logs worktree when set", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    ctx.worktree = "/tmp/test-worktree"
    await plugin.server(ctx as any)

    assert.ok(
      ctx.logs.some((l) => l.message.includes("oc-dw plugin loaded")),
      "should log with worktree set",
    )
  } finally {
    await cleanupDir(cwd)
  }
})

test("Plugin tool.execute validates required objective argument", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const execute = hooks.tool!.dynamic_workflow_run.execute

    await assert.rejects(
      () => execute({} as any, {} as any),
      /non-empty objective/,
      "should reject missing objective",
    )

    await assert.rejects(
      () => execute({ objective: "" } as any, {} as any),
      /non-empty objective/,
      "should reject empty objective",
    )
  } finally {
    await cleanupDir(cwd)
  }
})

test("Plugin tool.execute starts a workflow with valid objective (background mode)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const execute = hooks.tool!.dynamic_workflow_run.execute

    const result = await execute({ objective: "Create a hello world app" } as any, {} as any)
    assert.equal(typeof result, "string", "should return a string result")
    assert.ok((result as string).includes("workflow"), "result should mention workflow")
    assert.ok((result as string).includes(".opencode/dynamic-workflows/runs/"), "result should reference the run directory")
  } finally {
    await cleanupDir(cwd)
  }
})

test("Plugin tool.execute handles dry_run option", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const execute = hooks.tool!.dynamic_workflow_run.execute

    const result = await execute({ objective: "Test dry run", dry_run: true } as any, {} as any)
    assert.equal(typeof result, "string")
    assert.ok(
      (result as string).toLowerCase().includes("dry run"),
      "should indicate dry run",
    )
  } finally {
    await cleanupDir(cwd)
  }
})

test("Plugin tool.execute auto-detects dry run from objective hints", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const execute = hooks.tool!.dynamic_workflow_run.execute

    const result = await execute({ objective: "What will happen if I refactor this?" } as any, {} as any)
    assert.equal(typeof result, "string")
    assert.ok(
      (result as string).toLowerCase().includes("dry run"),
      "should auto-detect dry run from 'what will happen' hint",
    )
  } finally {
    await cleanupDir(cwd)
  }
})

test("Plugin tool.execute handles all optional arguments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const execute = hooks.tool!.dynamic_workflow_run.execute

    const result = await execute({
      objective: "Full options test",
      stopping_condition: "All tests pass",
      max_agents: 5,
      concurrency: 2,
      planner_model: "openai/gpt-5.1-codex",
      worker_model: "anthropic/claude-sonnet-4-5",
      effort: "high",
      adversarial_review: true,
      skill: ["test-driven", "strict-types"],
      token_budget: 50000,
    } as any, {} as any)

    assert.equal(typeof result, "string", "should handle all options without error")
  } finally {
    await cleanupDir(cwd)
  }
})

test("Plugin tool.execute rejects invalid effort level gracefully", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const execute = hooks.tool!.dynamic_workflow_run.execute

    const result = await execute({
      objective: "Test invalid effort",
      effort: "invalid-effort",
    } as any, {} as any)

    assert.equal(typeof result, "string", "should not crash on invalid effort")
  } finally {
    await cleanupDir(cwd)
  }
})

test("Named export DynamicWorkflowsPlugin also works as plugin function", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await DynamicWorkflowsPlugin(ctx as any)

    assert.ok(hooks.tool, "named export should also return valid hooks")
    assert.ok(hooks.tool!.dynamic_workflow_run, "named export should register the tool")
  } finally {
    await cleanupDir(cwd)
  }
})

// ---------------------------------------------------------------------------
// Zod schema validation tests
// ---------------------------------------------------------------------------

test("Tool args schema validates string args", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const args = hooks.tool!.dynamic_workflow_run.args

    assert.ok(args.objective, "objective arg should exist")
    assert.ok(args.stopping_condition, "stopping_condition arg should exist")
    assert.ok(args.planner_model, "planner_model arg should exist")

    // objective (required string)
    assert.ok(zParse(args.objective, "valid string").success, "objective should accept string")
    assert.ok(!zParse(args.objective, 123).success, "objective should reject number")
    assert.ok(!zParse(args.objective, null).success, "objective should reject null")
    assert.ok(!zParse(args.objective, undefined).success, "objective should reject undefined")

    // optional string
    assert.ok(zParse(args.stopping_condition, "valid").success, "stopping_condition should accept string")
    assert.ok(zParse(args.stopping_condition, undefined).success, "stopping_condition should accept undefined")
    assert.ok(!zParse(args.stopping_condition, 123).success, "stopping_condition should reject number")
  } finally {
    await cleanupDir(cwd)
  }
})

test("Tool args schema validates number args", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const args = hooks.tool!.dynamic_workflow_run.args

    assert.ok(args.max_agents, "max_agents arg should exist")
    assert.ok(args.concurrency, "concurrency arg should exist")
    assert.ok(args.token_budget, "token_budget arg should exist")

    // Valid numbers
    assert.ok(zParse(args.max_agents, 10).success, "max_agents should accept number")
    assert.ok(zParse(args.max_agents, 1).success, "max_agents should accept 1")
    assert.ok(zParse(args.max_agents, 0).success, "max_agents should accept 0")
    assert.ok(zParse(args.max_agents, undefined).success, "optional number should accept undefined")

    // Invalid
    assert.ok(!zParse(args.max_agents, "ten").success, "max_agents should reject string")
    assert.ok(!zParse(args.max_agents, true).success, "max_agents should reject boolean")
    assert.ok(!zParse(args.max_agents, null).success, "max_agents should reject null")
  } finally {
    await cleanupDir(cwd)
  }
})

test("Tool args schema validates boolean args", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const args = hooks.tool!.dynamic_workflow_run.args

    assert.ok(args.dry_run, "dry_run arg should exist")
    assert.ok(args.background, "background arg should exist")
    assert.ok(args.require_approval, "require_approval arg should exist")
    assert.ok(args.adversarial_review, "adversarial_review arg should exist")
    assert.ok(args.save_workflow, "save_workflow arg should exist")

    // Valid booleans
    assert.ok(zParse(args.dry_run, true).success, "dry_run should accept true")
    assert.ok(zParse(args.dry_run, false).success, "dry_run should accept false")
    assert.ok(zParse(args.dry_run, undefined).success, "optional boolean should accept undefined")

    // Invalid
    assert.ok(!zParse(args.dry_run, "yes").success, "dry_run should reject string")
    assert.ok(!zParse(args.dry_run, 1).success, "dry_run should reject number")
    assert.ok(!zParse(args.dry_run, null).success, "dry_run should reject null")
  } finally {
    await cleanupDir(cwd)
  }
})

test("Tool args schema validates enum args (effort)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const args = hooks.tool!.dynamic_workflow_run.args

    assert.ok(args.effort, "effort arg should exist")

    // Valid enum values
    assert.ok(zParse(args.effort, "low").success, "effort should accept low")
    assert.ok(zParse(args.effort, "medium").success, "effort should accept medium")
    assert.ok(zParse(args.effort, "high").success, "effort should accept high")
    assert.ok(zParse(args.effort, "ultra").success, "effort should accept ultra")
    assert.ok(zParse(args.effort, undefined).success, "optional enum should accept undefined")

    // Invalid enum values
    assert.ok(!zParse(args.effort, "extreme").success, "effort should reject invalid value")
    assert.ok(!zParse(args.effort, "").success, "effort should reject empty string")
    assert.ok(!zParse(args.effort, 123).success, "effort should reject number")
    assert.ok(!zParse(args.effort, "HIGH").success, "effort should reject wrong case")
  } finally {
    await cleanupDir(cwd)
  }
})

test("Tool args schema validates array args (skill)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const args = hooks.tool!.dynamic_workflow_run.args

    assert.ok(args.skill, "skill arg should exist")

    // Valid array of strings
    assert.ok(zParse(args.skill, ["test-driven"]).success, "skill should accept string array")
    assert.ok(zParse(args.skill, ["a", "b", "c"]).success, "skill should accept multiple strings")
    assert.ok(zParse(args.skill, []).success, "skill should accept empty array")
    assert.ok(zParse(args.skill, undefined).success, "optional array should accept undefined")

    // Invalid array contents
    assert.ok(!zParse(args.skill, "not-an-array").success, "skill should reject string")
    assert.ok(!zParse(args.skill, [1, 2, 3]).success, "skill should reject number array")
    assert.ok(!zParse(args.skill, [true]).success, "skill should reject boolean array")
    assert.ok(!zParse(args.skill, null).success, "skill should reject null")
  } finally {
    await cleanupDir(cwd)
  }
})

test("Tool args schema: all optional args accept undefined", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)
    const args: Record<string, { parse: (v: unknown) => unknown }> = hooks.tool!.dynamic_workflow_run.args as unknown as Record<string, { parse: (v: unknown) => unknown }>

    // All optional args should accept undefined
    const optionalArgs = [
      "stopping_condition", "max_agents", "concurrency",
      "planner_model", "worker_model", "verifier_model", "synthesizer_model",
      "background", "effort", "require_approval", "adversarial_review",
      "template", "skill", "token_budget", "save_workflow",
      "workflow_name", "dry_run",
    ]
    for (const argName of optionalArgs) {
      assert.ok(args[argName], `${argName} should exist in schema`)
      const result = zParse(args[argName], undefined)
      assert.ok(result.success, `${argName} should accept undefined (optional)`)
    }

    // objective is required — should NOT accept undefined
    assert.ok(!zParse(args.objective, undefined).success, "objective should reject undefined (required)")
  } finally {
    await cleanupDir(cwd)
  }
})

// ---------------------------------------------------------------------------
// Package resolution smoke test
// ---------------------------------------------------------------------------

test("Plugin can be imported via dist path (simulating package resolution)", async () => {
  const { pathToFileURL } = await import("node:url")
  const distPath = join(process.cwd(), "dist", "src", "index.js")

  // Dynamic import of the compiled dist output (simulates import("oc-dw"))
  const fileUrl = pathToFileURL(distPath).href
  const mod = await import(fileUrl)

  // Verify the module has the expected exports
  assert.ok(mod.default, "should have default export (PluginModule)")
  assert.ok(mod.plugin, "should have named 'plugin' export")
  assert.ok(mod.DynamicWorkflowsPlugin, "should have named DynamicWorkflowsPlugin export")
  assert.ok(mod.SdkLikeWorkflowClient, "should export SdkLikeWorkflowClient")
  assert.ok(mod.DynamicWorkflowRunner, "should export DynamicWorkflowRunner")
  assert.ok(mod.FileWorkflowStore, "should export FileWorkflowStore")
  assert.ok(mod.WorkflowRuntime, "should export WorkflowRuntime")
  assert.ok(mod.ScriptExecutor, "should export ScriptExecutor")

  // Verify the PluginModule shape
  assert.equal(typeof mod.default.server, "function", "default.server should be a function")
  assert.equal(typeof mod.plugin.server, "function", "plugin.server should be a function")
  assert.equal(mod.default.server, mod.plugin.server, "default and named plugin should be the same")
})

// ---------------------------------------------------------------------------
// Live plugin lifecycle smoke test
// ---------------------------------------------------------------------------

test("Plugin lifecycle smoke test — init, dry-run execute, verify artifacts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)

    // 1. Initialize plugin (simulates OpenCode loading the plugin)
    const hooks = await plugin.server(ctx as any)
    assert.ok(hooks.tool, "plugin should return tool hooks")

    // 2. Execute a dry run workflow synchronously (background: false) so state is finalized
    const result = await hooks.tool!.dynamic_workflow_run.execute({
      objective: "Create a README file",
      dry_run: true,
      background: false,
    } as any, {} as any)

    // 3. Verify the result
    assert.equal(typeof result, "string", "should return a string result")
    assert.ok((result as string).includes(".opencode/dynamic-workflows/runs/") || (result as string).includes("planned"), "should reference run directory or indicate dry run")

    // 4. Verify state files were written
    const { readFile, readdir } = await import("node:fs/promises")
    const runsDir = join(cwd, ".opencode", "dynamic-workflows", "runs")
    const runDirs = await readdir(runsDir)
    assert.ok(runDirs.length > 0, "should have created at least one run directory")

    const runDir = join(runsDir, runDirs[0])
    const stateRaw = await readFile(join(runDir, "state.json"), "utf8")
    const state = JSON.parse(stateRaw)
    assert.equal(state.status, "paused", "dry run should pause the workflow")
    assert.ok(state.script, "should have generated a script")
    assert.ok(state.plan, "should have a plan")

    // 5. Verify plan artifact
    const planRaw = await readFile(join(runDir, "plan.json"), "utf8")
    const plan = JSON.parse(planRaw)
    assert.ok(plan.title, "plan should have a title")

    // 6. Verify script artifact
    const scriptRaw = await readFile(join(runDir, "workflow-script.js"), "utf8")
    assert.ok(scriptRaw.length > 0, "script artifact should have content")

    // 7. Verify events were logged
    const eventsRaw = await readFile(join(runDir, "events.jsonl"), "utf8")
    const events = eventsRaw.trim().split("\n").map((line) => JSON.parse(line))
    assert.ok(events.some((e: { type: string }) => e.type === "workflow.created"), "should have created event")
    assert.ok(events.some((e: { type: string }) => e.type === "workflow.planned"), "should have planned event")
  } finally {
    await cleanupDir(cwd)
  }
})
