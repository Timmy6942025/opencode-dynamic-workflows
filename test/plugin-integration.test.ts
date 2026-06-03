import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

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

import plugin from "../src/plugin.js"
import { DynamicWorkflowsPlugin } from "../src/plugin.js"

// ---------------------------------------------------------------------------
// Simulate OpenCode's plugin loader
// ---------------------------------------------------------------------------

/**
 * Simulates what OpenCode does when loading a plugin:
 * 1. Import the module
 * 2. Check for module.server (PluginModule shape)
 * 3. Call server(ctx) to initialize the plugin
 * 4. Verify the returned Hooks contain the expected tools
 */

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

test("PluginModule export shape matches OpenCode expectations", () => {
  // OpenCode's plugin loader does: const mod = await import("oc-dw"); mod.server(ctx)
  assert.ok(plugin, "default export should exist")
  assert.equal(typeof plugin, "object", "default export should be an object (PluginModule)")
  assert.equal(typeof plugin.server, "function", "PluginModule.server should be a function")

  // The named export should also work
  assert.equal(typeof DynamicWorkflowsPlugin, "function", "DynamicWorkflowsPlugin should be a function")
  assert.equal(plugin.server, DynamicWorkflowsPlugin, "server should point to the plugin function")
})

test("Plugin initializes and returns Hooks with tool definition", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-plugin-test-"))
  try {
    const ctx = createMockCtx(cwd)
    const hooks = await plugin.server(ctx as any)

    // Verify the hooks object
    assert.ok(hooks, "plugin should return hooks")
    assert.ok(hooks.tool, "hooks should have a tool property")
    assert.ok(hooks.tool!.dynamic_workflow_run, "should register dynamic_workflow_run tool")

    // Verify the tool definition
    const toolDef = hooks.tool!.dynamic_workflow_run
    assert.ok(toolDef.description, "tool should have a description")
    assert.ok(toolDef.description.includes("dynamic workflow"), "description should mention workflow")
    assert.equal(typeof toolDef.execute, "function", "tool should have an execute function")
    assert.ok(toolDef.args, "tool should have args schema")
  } finally {
    await cleanupDir(cwd)
  }
})

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

    // Missing objective should throw
    await assert.rejects(
      () => execute({} as any, {} as any),
      /non-empty objective/,
      "should reject missing objective",
    )

    // Empty objective should throw
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

    // Valid objective should return a string (background mode)
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

    // Invalid effort should be ignored (falls back to default)
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
