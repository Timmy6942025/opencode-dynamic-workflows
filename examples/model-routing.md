# Model Routing Examples

Use any model/provider configured in OpenCode.

```bash
ocdw run "Find and fix flaky tests across the repo" \
  --planner-model openai/gpt-5.1-codex \
  --worker-model anthropic/claude-sonnet-4-5 \
  --verifier-model google/gemini-3-pro \
  --synthesizer-model openai/gpt-5.1-codex
```

Local OpenAI-compatible provider:

```bash
ocdw run "Audit TODO comments and group them by subsystem" \
  --planner-model ollama/qwen2.5-coder \
  --worker-model ollama/qwen2.5-coder \
  --verifier-model ollama/deepseek-coder
```

High fan-out read-only audit:

```bash
ocdw run "Audit every package for missing license headers" \
  --concurrency 32 \
  --max-agents 250 \
  --verification-rounds 1 \
  --dry-run
```
