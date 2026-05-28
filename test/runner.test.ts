import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import { defaultWorkflowOptions, optionsFromState } from "../src/options.js"
import { DynamicWorkflowRunner } from "../src/runner.js"
import { FileWorkflowStore } from "../src/state.js"
import type { WorkflowPlan } from "../src/types.js"
import { MockWorkflowClient } from "./mock-client.js"

function samplePlan(): WorkflowPlan {
  return {
    title: "Sample",
    summary: "Sample dynamic workflow",
    maxAgentEstimate: 3,
    phases: [
      {
        id: "survey",
        title: "Survey",
        description: "Survey files",
        strategy: "Scout first",
        dependsOn: [],
        qualityGates: [],
        verification: { strategy: "Verify survey" },
        tasks: [
          {
            id: "survey-task",
            title: "Survey task",
            prompt: "Survey the repo",
            role: "scout",
            targetFiles: [],
            acceptanceCriteria: ["Survey exists"],
            expectedArtifacts: ["survey"],
            canEdit: false,
            dependsOn: [],
          },
        ],
      },
      {
        id: "execute",
        title: "Execute",
        description: "Do work",
        strategy: "Workers after scout",
        dependsOn: ["survey"],
        qualityGates: ["npm test"],
        verification: { strategy: "Verify execution" },
        tasks: [
          {
            id: "task-a",
            title: "Task A",
            prompt: "Do A",
            role: "worker",
            targetFiles: ["src/a.ts"],
            acceptanceCriteria: ["A done"],
            expectedArtifacts: ["patch"],
            canEdit: true,
            dependsOn: [],
          },
          {
            id: "task-b",
            title: "Task B",
            prompt: "Do B after A",
            role: "worker",
            targetFiles: ["src/b.ts"],
            acceptanceCriteria: ["B done"],
            expectedArtifacts: ["patch"],
            canEdit: true,
            dependsOn: ["task-a"],
          },
        ],
      },
    ],
  }
}

test("runner plans, executes DAG tasks, verifies, gates, and writes summary artifacts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocdw-runner-"))
  try {
    const plan = samplePlan()
    const client = new MockWorkflowClient(plan)
    const store = new FileWorkflowStore(cwd)
    const runner = new DynamicWorkflowRunner(client, store)
    const options = defaultWorkflowOptions("Complete the sample workflow", cwd)
    options.concurrency = 8
    options.models = {
      planner: "openai/planner",
      scout: "local/scout",
      worker: "anthropic/worker",
      verifier: "google/verifier",
      synthesizer: "openai/synth",
    }

    const state = await runner.run(options)

    assert.equal(state.status, "completed")
    assert.equal(Object.values(state.tasks).filter((task) => task.status === "completed").length, 3)
    assert.equal(state.tasks["task-b"].verified, true)
    assert.deepEqual(client.shells, ["npm test"])
    assert.ok(state.summaryPath)
    assert.match(await readFile(state.summaryPath!, "utf8"), /Final Report/)

    const workerPrompts = client.prompts.filter((prompt) => prompt.text.includes("Run task"))
    assert.equal(workerPrompts.length, 3)
    const taskAIndex = workerPrompts.findIndex((prompt) => prompt.text.includes("task-a"))
    const taskBIndex = workerPrompts.findIndex((prompt) => prompt.text.includes("task-b"))
    assert.ok(taskAIndex >= 0 && taskBIndex > taskAIndex)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("dry run checkpoints the plan and resume completes it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocdw-resume-"))
  try {
    const client = new MockWorkflowClient(samplePlan())
    const store = new FileWorkflowStore(cwd)
    const runner = new DynamicWorkflowRunner(client, store)
    const options = defaultWorkflowOptions("Resume sample", cwd)
    options.dryRun = true

    const dry = await runner.run(options)
    assert.equal(dry.status, "paused")
    assert.ok(dry.plan)

    const resumeOptions = optionsFromState(dry)
    const resumed = await runner.run(resumeOptions)
    assert.equal(resumed.status, "completed")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
