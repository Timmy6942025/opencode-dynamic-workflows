# opencode-dynamic-workflows

Model-agnostic dynamic workflow orchestration for OpenCode. Inspired by Claude Dynamic Workflows and OpenAI Codex `/goal`.

This project lets OpenCode users launch high-effort workflows that **plan**, **fan out**, **coordinate**, **verify**, **resume**, and **summarize** many OpenCode subagent sessions across a codebase. It is intentionally provider neutral: every model is an OpenCode `provider/model` id, so routing can use Claude, GPT, Gemini, Kimi, DeepSeek, Grok, local models, or any other provider configured in OpenCode.

## Install

This is a **source-only** project. It is not published to the npm registry and cannot be installed via `npm install -g opencode-dynamic-workflows`. Clone the repository, install development dependencies, and build locally:

```bash
git clone https://github.com/Timmy6942025/opencode-dynamic-workflows.git
cd opencode-dynamic-workflows
npm install   # installs local dev dependencies only
npm run build
```

Then run it directly from the repo:

```bash
node dist/cli.js run "Audit every API route for missing auth checks and produce verified fixes" \
  --cwd . \
  --concurrency 16 \
  --max-agents 200 \
  --planner-model openai/gpt-5.1-codex \
  --worker-model anthropic/claude-sonnet-4-5 \
  --verifier-model google/gemini-3-pro \
  --synthesizer-model openai/gpt-5.1-codex
```

Or link it globally if you prefer:

```bash
npm link
```

## Quick Start

Run OpenCode's server/TUI in the project you want to operate on, then launch a workflow:

```bash
ocdw run "Refactor the auth layer to use JWT tokens instead of sessions" \
  --concurrency 8 \
  --max-agents 50
```

Check progress:

```bash
ocdw status
ocdw dashboard
ocdw list
```

Resume or abort:

```bash
ocdw resume <workflow-id>
ocdw abort <workflow-id>
ocdw pause <workflow-id>
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `ocdw run "<objective>"` | Start a new workflow |
| `ocdw resume [id]` | Resume a paused or failed workflow |
| `ocdw status [id]` | Show workflow state and task summary |
| `ocdw list` | List all workflows |
| `ocdw abort [id]` | Abort a running workflow |
| `ocdw pause [id]` | Pause a running workflow |
| `ocdw approve [id]` | Approve a workflow awaiting approval |
| `ocdw reject [id]` | Reject a workflow awaiting approval |
| `ocdw templates` | List built-in workflow templates |
| `ocdw skills` | List built-in skill constraints |
| `ocdw dashboard [id]` | Show real-time progress dashboard |
| `ocdw install-command` | Install the `/workflow` command in OpenCode |

## CLI Options

### Core Options
- `--cwd <path>` — Project directory (default: `.`)
- `--base-url <url>` — OpenCode server URL (default: `http://localhost:4096`)
- `--start-server` — Start an OpenCode server through the SDK
- `--concurrency <n>` — Concurrent OpenCode sessions (default: 16)
- `--max-agents <n>` — Max worker tasks in the plan (default: 1000)
- `--verification-rounds <n>` — Verifier sessions per task (default: 1)
- `--retry-limit <n>` — Retries after failed worker/verification (default: 1)
- `--dry-run` — Plan and checkpoint without executing
- `--cleanup` — Delete OpenCode sessions after collecting outputs
- `--json` — Emit JSON logs/results
- `--no-fail-fast` — Continue on task/phase failures

### Model Routing
- `--model role=provider/model` — Generic role model override
- `--planner-model <provider/model>`
- `--worker-model <provider/model>`
- `--verifier-model <provider/model>`
- `--synthesizer-model <provider/model>`
- `--critic-model <provider/model>`
- `--scout-model <provider/model>`

### Workflow Features
- `--stopping-condition <text>` — Explicit stopping condition / verifiable end state
- `--effort <low|medium|high|ultra>` — Effort level (default: high)
- `--permission-mode <full|plan|ask>` — Permission mode (default: full)
- `--require-approval` — Require human approval before executing plan
- `--adversarial-review` — Enable adversarial review with convergence detection
- `--convergence-threshold <n>` — Adversarial convergence threshold 0–1 (default: 0.75)
- `--generate-orchestration-script` — Generate a dynamic orchestration script from the plan
- `--orchestration-mode <static|dynamic>` — Orchestration strategy (default: static)

### Templates & Skills
- `--template <id>` — Use a built-in workflow template (`deep-research`, `codebase-audit`, `large-migration`, `test-generation`, `documentation-update`)
- `--skill <id>` — Apply a skill constraint, repeatable (`no-casts`, `test-driven`, `minimal-diff`, `strict-types`, `security-first`, `performance-aware`, `docs-required`, `backward-compat`)

### Execution Control
- `--save-workflow` — Save completed workflow as a reusable template
- `--workflow-name <name>` — Name for saved workflow
- `--use-worktree` — Run in a git worktree for isolation
- `--worktree-name <name>` — Name for the worktree
- `--token-budget <n>` — Maximum token budget for this workflow
- `--context-offload-threshold <n>` — Char threshold for context offloading (default: 200000)
- `--progress-interval-ms <n>` — Progress report interval in ms (default: 60000)

## Built-In Templates

Templates provide pre-configured plans and options for common workflow types:

- **`deep-research`** — Multi-angle investigation with adversarial cross-checking and comprehensive synthesis
- **`codebase-audit`** — Systematic security/quality audit with up to 100 agents
- **`large-migration`** — Framework/language migration with parity verification
- **`test-generation`** — Comprehensive test generation with edge case coverage
- **`documentation-update`** — Documentation update/generation for a codebase

Use a template:

```bash
ocdw run "Research the best state management library for React in 2025" \
  --template deep-research \
  --adversarial-review
```

## Built-In Skills

Skills apply reusable constraints to all worker tasks:

- **`no-casts`** — Prohibit any type assertions or `any` casts
- **`test-driven`** — Require tests for every change
- **`minimal-diff`** — Make the smallest possible change
- **`strict-types`** — Enforce TypeScript strict mode compliance
- **`security-first`** — Evaluate all changes for security implications
- **`performance-aware`** — Consider algorithmic complexity and I/O efficiency
- **`docs-required`** — Document all public APIs and significant changes
- **`backward-compat`** — Maintain backward compatibility

Apply skills:

```bash
ocdw run "Add OAuth2 login support" \
  --skill security-first \
  --skill test-driven \
  --skill docs-required
```

## Features

### Planning & Orchestration
- **Structured planning** — LLM generates phases, tasks, dependencies, model roles, verification strategy, and quality gates via JSON schema
- **Dynamic orchestration scripts** — Optional generation of runnable TypeScript orchestration scripts
- **Template plans** — Built-in templates can bypass LLM planning entirely for known workflow patterns

### Execution
- **DAG execution** — Tasks run in dependency order with bounded concurrency
- **Quality gates** — Shell commands verify phase completion
- **Resumable** — File-backed checkpoints (`state.json`, `events.jsonl`, `plan.json`, `summary.md`)
- **Worktree isolation** — Run workflows in isolated git worktrees

### Quality Assurance
- **Multi-round verification** — Independent verifier agents check results against acceptance criteria
- **Adversarial review** — Critic and adversary agents debate results with convergence detection
- **Skill constraints** — Reusable prompt templates enforce coding standards across all tasks

### Observability
- **Token tracking** — Tracks estimated token usage across all sessions
- **Progress reports** — Periodic checkpoint reports generated during execution
- **Real-time dashboard** — CLI dashboard showing progress, blockers, and recent events
- **Approval gates** — Human-in-the-loop approval before workflow execution

### Integration
- **OpenCode Plugin** — Exposes `dynamic_workflow_run` tool for background execution
- **CLI** — Full command-line interface with JSON output support
- **Model-agnostic** — Route any role to any OpenCode provider/model

## Artifacts

Workflow artifacts are stored under:

```text
.opencode/dynamic-workflows/runs/<workflow-id>/
  state.json
  plan.json
  events.jsonl
  summary.md
  approval-request.md
  progress-<checkpoint>.md
  cached-results/
```

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

- **Planner session** — Uses structured output to create phases, tasks, dependencies, model roles, verification strategy, and quality gates.
- **Worker sessions** — Each task runs in an isolated OpenCode session with its own context. Skills are applied to task prompts before execution.
- **Verifier sessions** — Independent verifier agents check worker results against acceptance criteria and can trigger retries.
- **Adversarial sessions** — Critic and adversary reviewers cross-check findings with convergence detection.
- **Quality gates** — Planned shell commands run through OpenCode sessions and are recorded as evidence.
- **Synthesizer sessions** — Large result sets are chunked, summarized, then merged into one final report with agent-id references. Context offloading prevents token limit overflow.
- **State store** — File-backed checkpoints keep the workflow resumable and inspectable.

The default limits are deliberately conservative: 16 concurrent agents and 1,000 maximum total tasks. You can lower or raise both at run time.

See [docs/architecture.md](docs/architecture.md) for the runtime design and [docs/research-notes.md](docs/research-notes.md) for the source-derived implementation requirements.

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## License

MIT
