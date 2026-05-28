# Research Notes

These notes extract implementation constraints from the requested sources before architecture or code.

## OpenAI Codex `/goal`

Source: https://developers.openai.com/codex/use-cases/follow-goals

- Long-running autonomous work needs a durable objective, clear stopping condition, validation loop, checkpoints, and progress status.
- A goal should define what to achieve, what not to change, what evidence proves progress, and when to stop.
- Useful progress reports name the current checkpoint, verified evidence, remaining work, and blockers.

Implementation impact:

- Workflows persist state outside the live model context.
- Every run has an objective, workflow id, checkpoints, resumable task records, validation evidence, and final completion criteria.
- The CLI exposes `run`, `resume`, `status`, `list`, and `abort`.

## Claude Code Dynamic Workflows Docs

Source: https://code.claude.com/docs/en/workflows

- Dynamic workflows are generated orchestration scripts that coordinate subagents at scale.
- Runs happen in the background, expose progress, and show phases, agent counts, token totals, elapsed time, prompts, recent tool calls, and results.
- Workflows can be triggered explicitly with the word `workflow` or automatically by `ultracode`.
- Saved workflows become reusable commands.
- The runtime coordinates while agents do filesystem and shell work; the workflow itself should coordinate rather than directly mutate files.
- Claude's documented limits are 16 concurrent agents and 1,000 total agents per run.
- Completed agent results are cached for resume inside a session.
- Model routing should allow cheaper models for phases that do not need the strongest model.

Implementation impact:

- This package defaults to 16 concurrent sessions and supports up to 1,000 total tasks.
- The orchestrator manages phases, worker sessions, verification sessions, quality gates, and synthesis.
- It stores intermediate results as artifacts rather than feeding every worker transcript into the parent context.
- It includes an installer for an OpenCode command and a plugin tool for launching from OpenCode.

## Anthropic Blog Announcement

Source: https://claude.com/blog/introducing-dynamic-workflows-in-claude-code

- Workflows dynamically plan from the prompt, break work into subtasks, fan out to tens or hundreds of parallel subagents, verify before reporting, and synthesize one coordinated answer.
- Good use cases include codebase-wide bug hunts, optimization/security audits, large migrations, language ports, and high-stakes work that needs adversarial checking.
- Progress must be saved as the run goes so interruptions can resume.
- Parallel agents should work from independent angles, refute findings, and iterate until answers converge.
- Large workflows can consume much more model usage than a typical session.

Implementation impact:

- The planner asks for independent workstreams and explicit verification strategy.
- Workers are verified by separate verifier sessions.
- The synthesizer filters unsupported claims and cites agent ids.
- Concurrency, max agents, verification rounds, and model routing are explicit cost controls.

## Reddit Threads

Sources:

- https://www.reddit.com/r/ClaudeAI/comments/1tq9y9l/ultracode_effort/
- https://www.reddit.com/r/ClaudeAI/comments/1tq9ofy/introducing_dynamic_workflows_in_claude_code/

Extracted constraints:

- Users expect `ultracode` to mean high effort and automatic workflow orchestration, not just a larger single-agent reasoning setting.
- Community reaction emphasizes token burn risk, need for visibility, and value of custom workflow APIs.
- A reusable open implementation should not hard-code Claude-specific models.

Implementation impact:

- The CLI uses explicit high-effort orchestration controls while staying provider/model agnostic.
- Model ids are plain OpenCode ids in `provider/model` form.
- Status files and summaries make token-expensive behavior auditable.

## Hacker News Discussion

Source: https://news.ycombinator.com/item?id=48311705

- Developers are skeptical of raw token-maximization and want proof that extra agents improve correctness or coverage.
- Positive reports call out better automatic context management, smart phasing, validation, clean context windows, and visibility into in-flight runs.
- Users want DAG-like workflow semantics, pause/resume/retry, and stateful artifacts.

Implementation impact:

- The engine treats phases as a dependency graph.
- It retries failed verification when allowed and records verifier feedback.
- It keeps stateful artifacts on disk and supports resume.
- It avoids assuming that more agents are always better; `maxAgents`, `concurrency`, and quality gates are configurable.

## Digg Cluster

Source: https://digg.com/ai/omcvyxdp

- Public discussion frames the feature as a parallel subagent fleet for complex tasks.
- Posts highlight strict orchestration order across hundreds of agents and examples like cataloging hundreds of feature flags in under ten minutes.
- The same cluster warns that agent-to-agent interactions are powerful but token-heavy.

Implementation impact:

- The planner produces ordered phases with dependencies and agent counts.
- The executor is optimized for many small independent tasks.
- The summary and status surfaces report what happened instead of hiding the cost.

## X Posts

Sources:

- https://x.com/claudeai/status/2060042710753382816
- https://x.com/bridgemindai/status/2060054999854395747

Extracted via X oEmbed because the web page itself did not render text.

- Claude's post describes dynamic workflows as research-preview functionality where Claude plans, runs hundreds of parallel subagents, and verifies work before reporting back.
- BridgeMind's post describes UltraCode running more than 100 Opus 4.8 agents simultaneously across a broad ecosystem.

Implementation impact:

- The package is designed to support 100+ agents, with a documented maximum default of 1,000 total tasks and default concurrency of 16.
- Model routing is intentionally generic so the same orchestration can use Claude, GPT, Gemini, Kimi, DeepSeek, Grok, or local OpenCode providers.

## OpenCode Implementation Surface

Sources:

- https://opencode.ai/docs/sdk/
- https://dev.opencode.ai/docs/plugins/
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/models/
- https://opencode.ai/docs/commands/
- https://opencode.ai/docs/agents/

- OpenCode exposes a JS/TS SDK with session creation, session prompts, structured JSON output, file search/read, shell execution, config/providers, events, and logging.
- Plugins can add tools, hook into lifecycle events, and use the same SDK client.
- OpenCode supports 75+ providers through AI SDK and Models.dev, plus local models through OpenAI-compatible adapters.
- Model ids use `provider/model-id`.
- Commands can be installed in `.opencode/commands/` and can choose agent/model/subtask behavior.

Implementation impact:

- OpenCode sessions are used as subagents.
- The package ships both an external CLI and an OpenCode plugin tool.
- It uses OpenCode structured output for planning and verification.
- It never assumes a provider beyond OpenCode's `provider/model` ids.
