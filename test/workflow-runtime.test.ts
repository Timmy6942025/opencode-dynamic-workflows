import assert from "node:assert/strict"
import test from "node:test"

import { WorkflowRuntime } from "../src/workflow-runtime.js"
import { MockWorkflowClient } from "./mock-client.js"
import type { DynamicWorkflowOptions, WorkflowState } from "../src/types.js"
import { SilentReporter } from "../src/reporter.js"

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    id: "test-wf",
    objective: "test objective",
    cwd: "/tmp",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    options: {
      maxAgents: 10,
      concurrency: 4,
      cleanUpSessions: true,
      models: { worker: "openai/worker", synthesizer: "openai/synth", verifier: "openai/verify" },
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
    models: { worker: "openai/worker", synthesizer: "openai/synth", verifier: "openai/verify" },
    effortLevel: "medium",
    requireApproval: false,
    adversarialReview: false,
    saveWorkflow: false,
    useWorktree: false,
    skills: [],
    ...overrides,
  }
}

test("WorkflowRuntime.spawn creates an agent and runAgent uses promptAsync", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const agent = runtime.spawn("Test Worker", "Do the work", { role: "worker" })
  assert.ok(agent.id, "agent should have an id")
  assert.equal(agent.label, "Test Worker")

  const [result] = await runtime.wait(agent)
  assert.ok(result.text.includes("async worker output"), `unexpected text: ${result.text}`)
  assert.ok(result.tokensUsed > 0, "should track tokens")
  assert.ok(!result.error, "should not have an error")

  // Verify promptAsync was used (tracked in asyncPrompts, not prompts)
  assert.equal(client.asyncPrompts.length, 1, "should call promptAsync")
  assert.equal(client.prompts.length, 0, "should not call blocking prompt")
})

test("WorkflowRuntime.wait resolves multiple agents", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const a = runtime.spawn("A", "task a")
  const b = runtime.spawn("B", "task b")

  const results = await runtime.wait([a, b])
  assert.equal(results.length, 2)
  assert.ok(results[0].text)
  assert.ok(results[1].text)
})

test("WorkflowRuntime.parallel spawns and waits for all agents", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const results = await runtime.parallel([
    { label: "A", prompt: "task a", role: "worker" },
    { label: "B", prompt: "task b", role: "worker" },
    { label: "C", prompt: "task c", role: "worker" },
  ])

  assert.equal(results.length, 3)
  assert.equal(client.asyncPrompts.length, 3, "should spawn 3 agents via promptAsync")
})

test("WorkflowRuntime.forEach fans out with concurrency batching", async () => {
  const client = new MockWorkflowClient()
  const options = makeOptions({ concurrency: 2 })
  const runtime = new WorkflowRuntime(client, makeState(), options, new SilentReporter())

  const items = ["a", "b", "c", "d", "e"]
  const results = await runtime.forEach(items, (item, i) => ({
    label: `Process ${item}`,
    prompt: `Process item ${i}: ${item}`,
    role: "worker" as const,
  }))

  assert.equal(results.length, 5)
  assert.equal(client.asyncPrompts.length, 5)
})

test("WorkflowRuntime.map preserves item-result correlation", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const items = ["x", "y"]
  const mapped = await runtime.map(items, (item) => ({
    label: `Map ${item}`,
    prompt: `process ${item}`,
    role: "worker" as const,
  }))

  assert.equal(mapped.length, 2)
  assert.equal(mapped[0].item, "x")
  assert.equal(mapped[1].item, "y")
  assert.ok(mapped[0].result.text)
  assert.ok(mapped[1].result.text)
})

test("WorkflowRuntime.synthesize combines agent outputs", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const agents = [
    runtime.spawn("Agent A", "Find bugs"),
    runtime.spawn("Agent B", "Write tests"),
  ]

  const result = await runtime.synthesize({ agents })
  // Synthesizer goes through the blocking prompt path
  assert.ok(result.text.includes("Final Report"), "synthesizer should return the Final Report text")
})

test("WorkflowRuntime.adversarial verifies worker output", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const worker = runtime.spawn("Worker", "Implement feature X")
  const { worker: workerResult, verification } = await runtime.adversarial({
    worker,
    rubric: ["Feature works correctly", "Edge cases handled"],
  })

  assert.ok(workerResult.text, "worker should produce output")
  assert.equal(verification.pass, true)
  assert.ok(verification.confidence > 0)
  assert.ok(verification.evidence.length > 0)
})

test("WorkflowRuntime.tournament picks a winner via judge function", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  // Give each agent a different response
  let counter = 0
  client.workerResponseFn = (_sid, _prompt) => `response-${++counter}`

  const agents = [
    runtime.spawn("Idea 1", "Short idea"),
    runtime.spawn("Idea 2", "Long idea with more detail"),
    runtime.spawn("Idea 3", "Medium idea"),
    runtime.spawn("Idea 4", "Another idea"),
  ]

  // Judge picks the one with the longest text
  const winner = await runtime.tournament({
    agents,
    judge: (a, b) => a.text.length > b.text.length,
  })

  assert.ok(winner.text, "tournament should produce a winner")
  assert.equal(client.asyncPrompts.length, 4, "all agents should be spawned")
})

test("WorkflowRuntime.loop iterates until condition is met", async () => {
  const client = new MockWorkflowClient()
  let iterCount = 0
  client.workerResponseFn = () => {
    iterCount++
    return iterCount >= 3 ? "ALL TESTS PASS" : `attempt ${iterCount} failed`
  }

  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const results = await runtime.loop(
    (i, prev) => ({
      label: `Fix attempt ${i}`,
      prompt: prev ? `Previous: ${prev.text}. Fix remaining.` : "Start fixing",
    }),
    (result) => result.text.includes("ALL TESTS PASS"),
    5,
  )

  assert.equal(results.length, 3, "should stop after 3 iterations")
  assert.ok(results[results.length - 1].text.includes("ALL TESTS PASS"))
})

test("WorkflowRuntime.loop stops at maxIterations", async () => {
  const client = new MockWorkflowClient()
  client.workerResponseFn = () => "still broken"

  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const results = await runtime.loop(
    (i) => ({ label: `Iter ${i}`, prompt: "try again" }),
    () => false, // never satisfied
    3,
  )

  assert.equal(results.length, 3, "should stop at maxIterations")
})

test("WorkflowRuntime.shell runs a command", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const result = await runtime.shell("echo hello")
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, "ok")
  assert.ok(client.shells.includes("echo hello"))
  assert.ok(client.deleted.length > 0, "should clean up shell session")
})

test("WorkflowRuntime.ask returns the question", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const answer = await runtime.ask("What framework?")
  assert.equal(answer, "What framework?")
})

test("WorkflowRuntime.log logs through reporter", async () => {
  const client = new MockWorkflowClient()
  const messages: string[] = []
  const reporter = {
    info: (msg: string) => messages.push(`INFO: ${msg}`),
    warn: (msg: string) => messages.push(`WARN: ${msg}`),
    error: (msg: string) => messages.push(`ERROR: ${msg}`),
  }
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), reporter)

  runtime.log("info", "hello")
  runtime.log("warn", "careful")
  runtime.log("error", "oops")

  assert.ok(messages.some((m) => m.includes("INFO") && m.includes("hello")))
  assert.ok(messages.some((m) => m.includes("WARN") && m.includes("careful")))
  assert.ok(messages.some((m) => m.includes("ERROR") && m.includes("oops")))
})

test("WorkflowRuntime.truncate truncates long text", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  const short = runtime.truncate("hello", 10)
  assert.equal(short, "hello")

  const long = runtime.truncate("a".repeat(100), 10)
  assert.ok(long.length < 100)
  assert.ok(long.includes("truncated"))
})

test("WorkflowRuntime.getTotalTokensUsed tracks across agents", async () => {
  const client = new MockWorkflowClient()
  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())

  assert.equal(runtime.getTotalTokensUsed(), 0)

  await runtime.spawn("A", "task a").result
  const afterFirst = runtime.getTotalTokensUsed()
  assert.ok(afterFirst > 0)

  await runtime.spawn("B", "task b").result
  assert.ok(runtime.getTotalTokensUsed() > afterFirst)
})

test("WorkflowRuntime.runAgent handles errors gracefully", async () => {
  const client = new MockWorkflowClient()
  // Make createSession fail
  client.createSession = async () => { throw new Error("connection refused") }

  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())
  const agent = runtime.spawn("Broken", "will fail")

  const [result] = await runtime.wait(agent)
  assert.equal(result.error, "connection refused")
  assert.equal(result.text, "")
  assert.equal(result.tokensUsed, 0)
})

test("WorkflowRuntime.adversarial handles verifier rejection", async () => {
  const client = new MockWorkflowClient()
  client.verifierResponseFn = () => ({
    text: "fail",
    structured: {
      pass: false,
      confidence: 0.85,
      issues: ["Missing error handling", "No edge case coverage"],
      evidence: ["Only basic case tested"],
    },
  })

  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())
  const worker = runtime.spawn("Worker", "Write code")
  const { worker: workerResult, verification } = await runtime.adversarial({
    worker,
    rubric: ["Error handling present", "Edge cases covered"],
  })

  assert.ok(workerResult.text, "worker should produce output")
  assert.equal(verification.pass, false, "verifier should reject")
  assert.equal(verification.confidence, 0.85)
  assert.deepEqual(verification.issues, ["Missing error handling", "No edge case coverage"])
  assert.deepEqual(verification.evidence, ["Only basic case tested"])
})

test("WorkflowRuntime.adversarial falls back to regex when no structured output", async () => {
  const client = new MockWorkflowClient()
  // Return plain text without structured output — triggers regex fallback
  client.verifierResponseFn = () => ({
    text: "The output passed all checks.",
  })

  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())
  const worker = runtime.spawn("Worker", "Write code")
  const { verification } = await runtime.adversarial({ worker })

  assert.equal(verification.pass, true, "regex should match 'passed'")
  assert.equal(verification.confidence, 0.4, "should use default confidence")
  assert.ok(verification.issues.length > 0, "should include raw text as issue")
  assert.deepEqual(verification.evidence, [], "no structured evidence")
})

test("WorkflowRuntime.adversarial regex fallback rejects on failure text", async () => {
  const client = new MockWorkflowClient()
  client.verifierResponseFn = () => ({
    text: "The output fails to meet the criteria.",
  })

  const runtime = new WorkflowRuntime(client, makeState(), makeOptions(), new SilentReporter())
  const worker = runtime.spawn("Worker", "Write code")
  const { verification } = await runtime.adversarial({ worker })

  assert.equal(verification.pass, false, "regex should not match 'fails'")
  assert.equal(verification.confidence, 0.4)
})


