# Architecture

`opencode-dynamic-workflows` is an external orchestration runtime plus an optional OpenCode plugin entry point.

## Runtime Flow

1. The CLI or plugin receives an objective.
2. The planner creates an OpenCode session with the `plan` agent and requests a structured workflow plan.
3. The state store writes `.opencode/dynamic-workflows/runs/<workflow-id>/state.json`.
4. The executor walks the phase DAG.
5. Runnable tasks fan out through OpenCode sessions with bounded concurrency.
6. Worker tasks use OpenCode model routing and OpenCode agents:
   - `build` when edits are allowed
   - `explore` when the task must be read-only
7. Verifier sessions use the `plan` agent and structured output.
8. Quality gates run through OpenCode shell sessions.
9. Synthesis sessions compress large result sets and produce `summary.md`.

## State Layout

```text
.opencode/dynamic-workflows/
  latest
  runs/
    <workflow-id>/
      state.json
      events.jsonl
      plan.json
      summary.md
```

The state file is the source of truth for resume, status, abort, and final reporting. Events are append-only JSONL for logs and dashboards.

## Model Routing

Models are OpenCode model ids:

```text
provider/model-id
```

Routing roles:

- `planner`
- `worker`
- `scout`
- `critic`
- `verifier`
- `synthesizer`
- `default`

Examples:

```bash
ocdw run "Migrate the test suite to Vitest" \
  --model planner=openai/gpt-5.1-codex \
  --model worker=anthropic/claude-sonnet-4-5 \
  --model verifier=google/gemini-3-pro \
  --model synthesizer=openai/gpt-5.1-codex
```

If a role is omitted, OpenCode uses the configured default model.

## Concurrency And Scale

The default concurrency is 16 sessions and the default worker-task budget is 1,000. This supports 100+ task workflows while keeping backpressure explicit.

Tasks inside a phase are scheduled as a DAG:

- a task with no dependencies can start immediately
- a task with dependencies starts only after those task ids complete
- failed dependencies fail dependent tasks
- cyclic or unresolved dependencies are detected and recorded as task failures

## Verification

Every task can be independently verified. A verifier receives:

- the phase verification strategy
- the original task prompt
- acceptance criteria
- the worker output

The verifier returns structured JSON with pass/fail, confidence, evidence, issues, and optional retry prompt. Failed verification can trigger a worker retry.

## OpenCode Plugin

The plugin exposes:

```text
dynamic_workflow_run
```

It can run synchronously or in the background. Background mode checkpoints a workflow id before launching the runner, then logs failures through OpenCode.

## Limits

The runtime does not invent provider APIs. It relies on OpenCode sessions, prompts, agents, shell execution, and configured providers. Token accounting depends on what OpenCode exposes in message metadata; the current state model records workflow/task progress and artifacts but does not guarantee cross-provider token totals.
