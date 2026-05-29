# oc-dw — OpenCode Dynamic Workflows

> Claude Dynamic Workflows, but for OpenCode. Install once, use inside OpenCode forever.

`oc-dw` brings multi-agent workflow orchestration directly into OpenCode. No separate CLI to run, no servers to manage, no dashboard to open. Just tell OpenCode what you want done and it plans, fans out, verifies, and synthesizes — exactly like Claude Code's built-in dynamic workflows.

## Install

```bash
npm i -g oc-dw
```

## Setup

One command wires everything into OpenCode:

```bash
oc-dw setup
```

This does three things automatically:
1. Adds `"oc-dw"` to your `opencode.json` plugin list
2. Installs the `/workflow` custom command
3. Installs the `/ultrawork` custom command

Restart OpenCode. Done.

## Usage

Inside OpenCode, just ask:

```
/workflow Refactor the auth layer to use JWT tokens instead of sessions
```

Or for fire-and-forget mode that runs until completion:

```
/ultrawork Add comprehensive test coverage for the payment module
```

That's it. The agent calls `dynamic_workflow_run` behind the scenes, which:

1. **Plans** — Generates phases, tasks, dependencies, and model routing
2. **Fans out** — Spawns isolated worker sessions with scoped prompts
3. **Verifies** — Independent verifiers check results against acceptance criteria
4. **Synthesizes** — Merges all outputs into a final report
5. **Checkpoints** — File-backed state so workflows are resumable

Artifacts are stored under `.opencode/dynamic-workflows/runs/<workflow-id>/`.

## What it does

| Feature | What it means |
|--------|---------------|
| **Planning** | LLM generates a structured plan with phases, tasks, dependencies, model roles, and quality gates |
| **DAG execution** | Tasks run in dependency order with bounded concurrency |
| **Multi-round verification** | Independent verifier agents check every result |
| **Adversarial review** | Critic and adversary agents debate results with convergence detection |
| **Skill constraints** | Apply reusable rules like `test-driven`, `security-first`, `strict-types` to all workers |
| **Templates** | Built-in templates for `deep-research`, `codebase-audit`, `large-migration`, `test-generation`, `documentation-update` |
| **Resumable** | File-backed checkpoints keep state across restarts |
| **Model-agnostic** | Route any role to any OpenCode provider/model |

## Customizing workflows

The agent picks defaults automatically, but you can be explicit:

```
Run a dynamic workflow with:
- template: deep-research
- skill: security-first
- skill: test-driven
- adversarial_review: true
- effort: ultra
- stopping_condition: "All findings are cross-referenced with source code and documented in FINDINGS.md"
```

Available templates:
- `deep-research` — Multi-angle investigation with cross-checking
- `codebase-audit` — Systematic security/quality audit
- `large-migration` — Framework/language migration with parity verification
- `test-generation` — Comprehensive test generation with edge cases
- `documentation-update` — Doc update/generation for a codebase

Available skills:
- `no-casts` — Prohibit type assertions or `any`
- `test-driven` — Require tests for every change
- `minimal-diff` — Smallest possible change
- `strict-types` — Enforce TypeScript strict mode
- `security-first` — Evaluate all changes for security
- `performance-aware` — Consider complexity and I/O efficiency
- `docs-required` — Document all public APIs
- `backward-compat` — Maintain backward compatibility

## Architecture

- **Planner** — Uses structured output to create the workflow plan
- **Workers** — Each task runs in an isolated OpenCode session with scoped context
- **Verifiers** — Independent agents check against acceptance criteria
- **Adversaries** — Cross-check findings with convergence detection
- **Synthesizer** — Chunks and merges results into a final report
- **State store** — File-backed for resumability and inspection

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
```

## License

MIT
