# opencode-dynamic-workflows

Model-agnostic dynamic workflow orchestration for OpenCode.

This package lets OpenCode users launch high-effort workflows that plan, fan out, coordinate, verify, resume, and summarize many OpenCode subagent sessions across a codebase. It is intentionally provider neutral: every model is an OpenCode `provider/model` id, so routing can use Claude, GPT, Gemini, Kimi, DeepSeek, Grok, local models, or any other provider configured in OpenCode.

## Install

```bash
npm install -g opencode-dynamic-workflows
```

Run OpenCode's server/TUI in the project you want to operate on, then launch:

```bash
ocdw run "Audit every API route for missing auth checks and produce verified fixes" \
  --cwd . \
  --concurrency 16 \
  --max-agents 200 \
  --planner-model openai/gpt-5.1-codex \
  --worker-model anthropic/claude-sonnet-4-5 \
  --verifier-model google/gemini-3-pro \
  --synthesizer-model openai/gpt-5.1-codex
```

Useful commands:

```bash
ocdw status
ocdw list
ocdw resume <workflow-id>
ocdw abort <workflow-id>
ocdw install-command --cwd .
```

Artifacts are stored under:

```text
.opencode/dynamic-workflows/runs/<workflow-id>/
```

See [docs/architecture.md](docs/architecture.md) for the runtime design and [docs/research-notes.md](docs/research-notes.md) for the source-derived implementation requirements.

## OpenCode Plugin

Add the plugin to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-dynamic-workflows/plugin"]
}
```

The plugin exposes a `dynamic_workflow_run` tool. You can also install a command:

```bash
ocdw install-command --cwd .
```

Then run `/workflow <objective>` in OpenCode. The command asks the active agent to launch the plugin tool in the background.

## Architecture

- Planner session: uses structured output to create phases, tasks, dependencies, model roles, verification strategy, and quality gates.
- Worker sessions: each task runs in an isolated OpenCode session with its own context.
- Verifier sessions: independent verifier agents check worker results against acceptance criteria and can trigger retries.
- Quality gates: planned shell commands run through OpenCode sessions and are recorded as evidence.
- Synthesizer sessions: large result sets are chunked, summarized, then merged into one final report with agent-id references.
- State store: file-backed checkpoints keep the workflow resumable and inspectable.

The default limits are deliberately conservative: 16 concurrent agents and 1,000 maximum total tasks. You can lower or raise both at run time.
