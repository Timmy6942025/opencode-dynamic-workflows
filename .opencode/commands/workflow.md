---
description: Launch a dynamic workflow for the given objective
agent: plan
subtask: false
---

Run a dynamic workflow with multi-agent orchestration.

Objective: $ARGUMENTS

Context:
!git log --oneline -5 2>/dev/null || true
!git diff --stat 2>/dev/null || true

Use the dynamic_workflow_run tool with:
- objective: the user's goal
- background: true
- effort: "high"
- Include stopping_condition for verifiable end states.
- Use template if the objective matches: deep-research, codebase-audit, large-migration, test-generation, refactor, feature, api-design, performance, dependency-audit.
- Apply skills (security-first, test-driven, strict-types, docs-required) if relevant.

If the user says "--dry-run", "preview", or "plan only", add dry_run: true.

After starting, report the workflow ID and tell the user they can check status in .opencode/dynamic-workflows/runs/<id>/.
