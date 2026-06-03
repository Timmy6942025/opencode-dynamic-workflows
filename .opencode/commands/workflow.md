---
description: Launch a dynamic workflow for the given objective
agent: plan
subtask: false
---

Run a dynamic workflow that generates a custom JavaScript harness for the task, then executes it with multi-agent orchestration.

Objective: $ARGUMENTS

Use the dynamic_workflow_run tool with:
- objective: the user's goal
- background: true (default)
- effort: "high" (default)
- Include a stopping_condition if the user specified a verifiable end state.
- Use template if the objective matches a known pattern (deep-research, codebase-audit, large-migration, test-generation, documentation-update, refactor, feature, api-design, performance, dependency-audit).
- Apply skills (security-first, test-driven, strict-types, docs-required) if relevant.

The workflow will:
1. Generate a custom JavaScript harness script tailored to the task
2. Execute the script with spawn/wait/parallel/forEach/synthesize/adversarial primitives
3. Each spawned agent runs in its own isolated session with its own context window

If the user says "--dry-run", "preview", "plan only", or similar, add dry_run: true.

After starting, report the workflow ID and tell the user they can check status in .opencode/dynamic-workflows/runs/<id>/.
