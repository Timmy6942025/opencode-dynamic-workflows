---
description: Fire-and-forget dynamic workflow that runs until completion
agent: plan
subtask: false
---

Run a self-driving dynamic workflow that generates a custom JavaScript harness, delegates to specialist agents, verifies results, and synthesizes a final report. It does not stop until the objective is complete.

Objective: $ARGUMENTS

Use the dynamic_workflow_run tool with:
- objective: the user's goal
- background: true
- effort: "high"
- adversarial_review: true
- Set a clear stopping_condition.

This is the "just do it" command. The workflow generates a tailor-made script for the task and executes it with spawn/wait/parallel primitives. Start the workflow and return immediately.
