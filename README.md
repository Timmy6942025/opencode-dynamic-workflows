# oc-dw — OpenCode Dynamic Workflows

> Dynamic workflows for OpenCode, inspired by [Claude Code's dynamic workflows](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code).

`oc-dw` brings Claude-style dynamic workflow orchestration to OpenCode. Instead of rigid phase/task DAGs, the planner **writes a custom JavaScript harness** for each task — a script that spawns, coordinates, and verifies subagents using a workflow API.

## Install

```bash
npm i -g oc-dw
```

## Setup

```bash
oc-dw setup
```

This wires everything into OpenCode:
1. Adds `"oc-dw"` to your `opencode.json` plugin list
2. Installs the `/workflow` custom command
3. Installs the `/ultrawork` custom command

Restart OpenCode. Done.

## Usage

```
/workflow Refactor the auth layer to use JWT tokens instead of sessions
```

```
/ultrawork Add comprehensive test coverage for the payment module
```

The agent calls `dynamic_workflow_run` behind the scenes, which:

1. **Plans** — Generates a custom JavaScript workflow script tailored to the task
2. **Executes** — Runs the script in a sandboxed VM with the workflow API injected
3. **Agents** — Each `spawn()` creates an isolated OpenCode session with its own context window
4. **Synthesizes** — The script collects and combines results however it needs to

## How it works

The key insight from Claude Code: instead of a fixed orchestrator, the planner **writes a JavaScript harness** custom-built for the task. The script uses special functions to spawn and coordinate subagents:

```javascript
// Example: the planner might generate something like this
const results = await parallel([
  { label: "Research primary", prompt: "Find sources for...", role: "scout" },
  { label: "Research contrarian", prompt: "Find criticisms of...", role: "critic" },
])

const synthesis = await synthesize({
  agents: results.map((r, i) => spawn("Source " + i, r.text)),
  prompt: "Combine into a comprehensive report",
})

return synthesis.text
```

### Workflow API

These functions are injected as globals into every workflow script:

| Function | Description |
|----------|-------------|
| `spawn(label, prompt, opts?)` | Spawn a subagent. Returns immediately. |
| `wait(agent \| agent[])` | Block until agent(s) finish. Returns `AgentResult[]`. |
| `parallel([defs])` | Spawn multiple agents and wait for all. |
| `forEach(items, fn)` | Fan-out over an array, respecting concurrency limits. |
| `map(items, fn)` | Like forEach but preserves the mapping to inputs. |
| `synthesize({agents, prompt?})` | Combine multiple agent outputs into one result. |
| `adversarial({worker, rubric?})` | Verify a worker's output against criteria. |
| `tournament({agents, judge})` | Bracket-style competition between agents. |
| `loop(fn, until, max?)` | Keep spawning until a condition is met. |
| `shell(cmd, timeout?)` | Run a shell command. |
| `ask(question)` | Ask the user a question. |
| `log(level, message)` | Log info/warn/error. |
| `truncate(text, max)` | Truncate long text. |

### Patterns

The planner can compose these primitives into any pattern:

- **Fan-out & synthesize** — Split work across agents, merge results
- **Adversarial verification** — Worker + verifier with convergence check
- **Tournament** — Agents compete, judge picks the best
- **Classify & act** — Classifier agent routes to different strategies
- **Loop until done** — Keep iterating until a stop condition
- **Generate & filter** — Generate ideas, filter by rubric

## Customizing workflows

```
Run a dynamic workflow with:
- template: deep-research
- skill: security-first
- skill: test-driven
- adversarial_review: true
- effort: ultra
- stopping_condition: "All findings are cross-referenced with source code"
```

### Templates

Built-in script templates for common patterns:

| Template | Description |
|----------|-------------|
| `deep-research` | Multi-angle investigation with cross-checking |
| `codebase-audit` | Systematic security/quality audit |
| `large-migration` | Framework/language migration with verification |
| `test-generation` | Comprehensive test generation with edge cases |
| `documentation-update` | Doc update/generation |
| `refactor` | Systematic pattern refactoring |
| `feature` | End-to-end feature implementation |
| `api-design` | API design, implementation, and docs |
| `performance` | Performance optimization with benchmarks |
| `dependency-audit` | Dependency vulnerability and license audit |

### Skills

Reusable constraints applied to all spawned agents:

| Skill | Description |
|-------|-------------|
| `no-casts` | Prohibit type assertions or `any` |
| `test-driven` | Require tests for every change |
| `minimal-diff` | Smallest possible change |
| `strict-types` | Enforce TypeScript strict mode |
| `security-first` | Evaluate all changes for security |
| `performance-aware` | Consider complexity and I/O efficiency |
| `docs-required` | Document all public APIs |
| `backward-compat` | Maintain backward compatibility |

## Model routing

Route different roles to different models:

```
planner_model: anthropic/claude-opus-4-8
worker_model: anthropic/claude-sonnet-4-5
verifier_model: openai/gpt-5.1-codex
```

## Architecture

- **Planner** — LLM generates a JavaScript workflow script using the workflow API
- **Runtime** — Workflow API implementation (spawn, wait, parallel, etc.)
- **Executor** — Sandboxed VM that runs the script with the API injected
- **Agents** — Each `spawn()` creates an isolated OpenCode session
- **State** — File-backed for resumability; stores the script + agent log

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## License

MIT
