import assert from "node:assert/strict"
import test from "node:test"

import { defaultWorkflowOptions } from "../src/options.js"
import { MockWorkflowClient } from "./mock-client.js"
import { createDynamicPlan } from "../src/planner.js"

test("createDynamicPlan returns a plan with a script", async () => {
  const client = new MockWorkflowClient()
  const options = defaultWorkflowOptions("test objective", "/tmp")

  const plan = await createDynamicPlan(client, options)

  assert.ok(plan.title, "plan should have a title")
  assert.ok(plan.summary, "plan should have a summary")
  assert.ok(plan.script, "plan should have a script")
  assert.ok(plan.script.includes("spawn") || plan.script.includes("wait"), "script should use workflow API")
  assert.ok(plan.maxAgentEstimate > 0, "maxAgentEstimate should be positive")
})

test("createDynamicPlan falls back to a default script if planner returns empty", async () => {
  const client = new MockWorkflowClient()
  client.scriptToReturn = "" // Force fallback
  const options = defaultWorkflowOptions("test objective", "/tmp")

  const plan = await createDynamicPlan(client, options)

  assert.ok(plan.script, "plan should have a fallback script")
  assert.ok(plan.script.includes("Fallback") || plan.script.includes("Survey"), "should use fallback plan")
})
