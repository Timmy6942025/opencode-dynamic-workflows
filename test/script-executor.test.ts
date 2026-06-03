import assert from "node:assert/strict"
import test from "node:test"

import { ScriptExecutor } from "../src/script-executor.js"
import { MockWorkflowClient } from "./mock-client.js"
import type { DynamicWorkflowOptions, WorkflowState } from "../src/types.js"
import { SilentReporter } from "../src/reporter.js"

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    id: "test-exec",
    objective: "test objective",
    cwd: "/tmp",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    options: {
      maxAgents: 10,
      concurrency: 4,
      cleanUpSessions: true,
      models: { worker: "openai/worker" },
      effortLevel: "medium",
      requireApproval: false,
      adversarialReview: false,
      saveWorkflow: false,
      useWorktree: false,
      skills: [],
    },
    sessions: [],
    totalTokensUsed: 0,
    isTemplate: false,
    agentLog: [],
    ...overrides,
  }
}

function makeOptions(overrides?: Partial<DynamicWorkflowOptions>): DynamicWorkflowOptions {
  return {
    objective: "test objective",
    cwd: "/tmp",
    maxAgents: 10,
    concurrency: 4,
    cleanUpSessions: true,
    dryRun: false,
    models: { worker: "openai/worker" },
    effortLevel: "medium",
    requireApproval: false,
    adversarialReview: false,
    saveWorkflow: false,
    useWorktree: false,
    skills: [],
    ...overrides,
  }
}

test("ScriptExecutor.execute runs a simple script that returns a string", async () => {
  const client = new MockWorkflowClient()
  const executor = new ScriptExecutor(client, makeOptions(), new SilentReporter())

  const result = await executor.execute(makeState(), `return "hello from script"`)

  assert.equal(result.output, "hello from script")
  assert.ok(!result.error, "should not have an error")
  assert.ok(result.durationMs >= 0, "should track duration")
  assert.ok(result.runtime, "should provide runtime reference")
})

test("ScriptExecutor.execute runs a script with spawn/wait", async () => {
  const client = new MockWorkflowClient()
  const executor = new ScriptExecutor(client, makeOptions(), new SilentReporter())

  const script = `
const [result] = await wait(spawn("Test Worker", "Do the work", { role: "worker" }))
return result.text
`

  const result = await executor.execute(makeState(), script)

  assert.ok(result.output.length > 0, "should produce output")
  assert.ok(!result.error, "should not have an error")
  assert.equal(client.asyncPrompts.length, 1, "should spawn 1 agent via promptAsync")
})

test("ScriptExecutor.execute exposes workflow API as globals", async () => {
  const client = new MockWorkflowClient()
  const options = makeOptions({ tokenBudget: 50000, skills: ["typescript", "testing"] })
  const state = makeState({ objective: "build a dashboard" })
  const executor = new ScriptExecutor(client, options, new SilentReporter())

  const script = `
// Verify all API functions and constants are available
const checks = []
checks.push(typeof spawn === "function")
checks.push(typeof wait === "function")
checks.push(typeof parallel === "function")
checks.push(typeof forEach === "function")
checks.push(typeof map === "function")
checks.push(typeof synthesize === "function")
checks.push(typeof adversarial === "function")
checks.push(typeof tournament === "function")
checks.push(typeof loop === "function")
checks.push(typeof shell === "function")
checks.push(typeof ask === "function")
checks.push(typeof log === "function")
checks.push(typeof truncate === "function")
checks.push(typeof JSON === "object")
checks.push(typeof Math === "object")
checks.push(typeof Date === "function")
checks.push(typeof Promise === "function")
checks.push(typeof Map === "function")
checks.push(typeof Set === "function")
checks.push(typeof RegExp === "function")
checks.push(objective === "build a dashboard")
checks.push(maxAgents === 10)
checks.push(concurrency === 4)
checks.push(cwd === "/tmp")
checks.push(tokenBudget === 50000)
checks.push(Array.isArray(skills) && skills.length === 2)
return checks.every(Boolean) ? "all globals present" : "missing globals: " + checks.filter(c => !c).length
`

  const result = await executor.execute(state, script)
  assert.equal(result.output, "all globals present")
})

test("ScriptExecutor.execute provides console logging", async () => {
  const client = new MockWorkflowClient()
  const messages: string[] = []
  const reporter = {
    info: (msg: string) => messages.push(msg),
    warn: (msg: string) => messages.push(msg),
    error: (msg: string) => messages.push(msg),
  }
  const executor = new ScriptExecutor(client, makeOptions(), reporter)

  const script = `
console.log("hello log")
console.warn("hello warn")
console.error("hello error")
return "done"
`

  const result = await executor.execute(makeState(), script)
  assert.equal(result.output, "done")
  assert.ok(messages.some((m) => m.includes("hello log")), "should capture console.log")
  assert.ok(messages.some((m) => m.includes("hello warn")), "should capture console.warn")
  assert.ok(messages.some((m) => m.includes("hello error")), "should capture console.error")
})

test("ScriptExecutor.execute handles script errors gracefully", async () => {
  const client = new MockWorkflowClient()
  const executor = new ScriptExecutor(client, makeOptions(), new SilentReporter())

  const script = `throw new Error("intentional failure")`

  const result = await executor.execute(makeState(), script)

  assert.equal(result.output, "")
  assert.ok(result.error, "should have an error")
  assert.ok(result.error.includes("intentional failure"), "error should contain the message")
  assert.ok(result.durationMs >= 0, "should still track duration")
  assert.ok(result.runtime, "runtime should still be available on error")
})

test("ScriptExecutor.execute handles script that returns non-string", async () => {
  const client = new MockWorkflowClient()
  const executor = new ScriptExecutor(client, makeOptions(), new SilentReporter())

  const script = `return { key: "value", count: 42 }`

  const result = await executor.execute(makeState(), script)
  assert.ok(result.output.includes("value"), "should stringify returned objects")
  assert.ok(result.output.includes("42"))
})

test("ScriptExecutor.execute handles script that returns null/undefined", async () => {
  const client = new MockWorkflowClient()
  const executor = new ScriptExecutor(client, makeOptions(), new SilentReporter())

  const resultNull = await executor.execute(makeState(), `return null`)
  assert.equal(resultNull.output, "")

  const resultUndef = await executor.execute(makeState(), `return undefined`)
  assert.equal(resultUndef.output, "")
})

test("ScriptExecutor.execute tracks tokens used across agents", async () => {
  const client = new MockWorkflowClient()
  const executor = new ScriptExecutor(client, makeOptions(), new SilentReporter())

  const script = `
const results = await parallel([
  { label: "A", prompt: "task a", role: "worker" },
  { label: "B", prompt: "task b", role: "worker" },
])
return "done: " + results.length + " agents"
`

  const result = await executor.execute(makeState(), script)
  assert.equal(result.output, "done: 2 agents")
  assert.ok(result.runtime.getTotalTokensUsed() > 0, "should track tokens from spawned agents")
})

test("ScriptExecutor.execute handles syntax errors in script", async () => {
  const client = new MockWorkflowClient()
  const executor = new ScriptExecutor(client, makeOptions(), new SilentReporter())

  const script = `this is not valid javascript @#$`

  const result = await executor.execute(makeState(), script)
  assert.ok(result.error, "should catch syntax errors")
  assert.equal(result.output, "")
})

test("ScriptExecutor.execute works with async operations", async () => {
  const client = new MockWorkflowClient()
  const executor = new ScriptExecutor(client, makeOptions(), new SilentReporter())

  const script = `
await new Promise(resolve => setTimeout(resolve, 10))
return "async complete"
`

  const result = await executor.execute(makeState(), script)
  assert.equal(result.output, "async complete")
})

test("ScriptExecutor.execute cannot access require or import", async () => {
  const client = new MockWorkflowClient()
  const executor = new ScriptExecutor(client, makeOptions(), new SilentReporter())

  const script = `return typeof require`

  const result = await executor.execute(makeState(), script)
  assert.equal(result.output, "undefined", "require should not be available in sandbox")
})
