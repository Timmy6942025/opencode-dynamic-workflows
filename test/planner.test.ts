import assert from "node:assert/strict"
import test from "node:test"

import { defaultWorkflowOptions } from "../src/options.js"
import { normalizePlan } from "../src/planner.js"

test("normalizePlan caps planner output to maxAgents and normalizes task ids", () => {
  const options = defaultWorkflowOptions("test objective", "/tmp")
  options.maxAgents = 2
  const plan = normalizePlan(
    {
      title: "Big plan",
      summary: "summary",
      maxAgentEstimate: 10,
      phases: [
        {
          id: "Phase One",
          title: "Phase One",
          description: "desc",
          strategy: "fan out",
          dependsOn: [],
          qualityGates: ["npm test"],
          verification: { strategy: "verify" },
          tasks: [
            { id: "Task A", title: "A", prompt: "Do A", role: "worker", acceptanceCriteria: ["A"], canEdit: true },
            { id: "Task B", title: "B", prompt: "Do B", role: "critic", acceptanceCriteria: ["B"], canEdit: false },
            { id: "Task C", title: "C", prompt: "Do C", role: "worker", acceptanceCriteria: ["C"], canEdit: false },
          ],
        },
      ],
    },
    options,
  )

  assert.equal(plan.phases.length, 1)
  assert.equal(plan.phases[0].id, "phase-one")
  assert.deepEqual(
    plan.phases[0].tasks.map((task) => task.id),
    ["task-a", "task-b"],
  )
  assert.equal(plan.phases[0].tasks[1].role, "critic")
})
