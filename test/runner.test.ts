import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { defaultWorkflowOptions, optionsFromState } from "../src/options.js"
import { DynamicWorkflowRunner } from "../src/runner.js"
import { FileWorkflowStore } from "../src/state.js"
import { MockWorkflowClient } from "./mock-client.js"

test("runner plans, executes workflow script, and writes summary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-runner-"))
  try {
    const client = new MockWorkflowClient()
    // Use a simple script that returns a result
    client.scriptToReturn = `
const [result] = await wait(spawn("Test Worker", "Do the work", { role: "worker" }))
return result.text
`

    const store = new FileWorkflowStore(cwd)
    const runner = new DynamicWorkflowRunner(client, store)
    const options = defaultWorkflowOptions("Complete the sample workflow", cwd)
    options.concurrency = 8
    options.cleanUpSessions = true
    options.models = {
      planner: "openai/planner",
      worker: "anthropic/worker",
      verifier: "google/verifier",
      synthesizer: "openai/synth",
    }

    const state = await runner.run(options)

    assert.equal(state.status, "completed")
    assert.ok(state.script, "state should have the generated script")
    assert.ok(state.scriptOutput, "state should have script output")
    assert.ok(state.summaryPath, "state should have a summary path")
    assert.ok(state.totalTokensUsed >= 0, "tokens should be tracked")

    // Verify artifacts were written
    const scriptArtifact = await readFile(join(cwd, ".opencode", "dynamic-workflows", "runs", state.id, "workflow-script.js"), "utf8")
    assert.ok(scriptArtifact.length > 0, "script artifact should exist")

    const planArtifact = await readFile(join(cwd, ".opencode", "dynamic-workflows", "runs", state.id, "plan.json"), "utf8")
    assert.ok(planArtifact.includes("Mock Workflow"), "plan artifact should contain the title")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("dry run checkpoints the plan and resume completes it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "oc-dw-resume-"))
  try {
    const client = new MockWorkflowClient()
    const store = new FileWorkflowStore(cwd)
    const runner = new DynamicWorkflowRunner(client, store)
    const options = defaultWorkflowOptions("Resume sample", cwd)
    options.dryRun = true

    const dry = await runner.run(options)
    assert.equal(dry.status, "paused")
    assert.ok(dry.script, "dry run should save the script")

    const resumeOptions = optionsFromState(dry)
    const resumed = await runner.run(resumeOptions)
    assert.equal(resumed.status, "completed")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
