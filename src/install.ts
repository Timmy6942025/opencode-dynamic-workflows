import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export async function installWorkflowCommand(cwd: string, global = false): Promise<string> {
  const base = global ? join(homedir(), ".config", "opencode") : join(resolve(cwd), ".opencode")
  const path = join(base, "commands", "workflow.md")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, workflowCommandTemplate(), "utf8")
  return path
}

export async function installUltraworkCommand(cwd: string, global = false): Promise<string> {
  const base = global ? join(homedir(), ".config", "opencode") : join(resolve(cwd), ".opencode")
  const path = join(base, "commands", "ultrawork.md")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, ultraworkCommandTemplate(), "utf8")
  return path
}

export async function setupOpenCodePlugin(cwd: string, global = false): Promise<string> {
  const configDir = global
    ? join(homedir(), ".config", "opencode")
    : join(resolve(cwd), ".opencode")
  const configPath = join(configDir, "opencode.json")

  let config: { plugin?: unknown; $schema?: string } = {}
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, "utf8")
      config = JSON.parse(raw) as { plugin?: unknown; $schema?: string }
    } catch {
      config = {}
    }
  }

  if (!config.$schema) {
    config.$schema = "https://opencode.ai/config.json"
  }

  const existing = Array.isArray(config.plugin) ? config.plugin : []
  const plugins = new Set(existing)
  plugins.add("oc-dw")
  config.plugin = [...plugins]

  await mkdir(configDir, { recursive: true })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")

  return configPath
}

function workflowCommandTemplate(): string {
  return `---
description: Launch a dynamic workflow for the given objective
agent: plan
subtask: false
---

Run a high-effort dynamic workflow with multi-agent orchestration, verification, and synthesis.

Objective: $ARGUMENTS

Use the dynamic_workflow_run tool with:
- objective: the user's goal
- background: true (default)
- effort: "high" (default)
- Include a stopping_condition if the user specified a verifiable end state.
- Use template if the objective matches a known pattern (deep-research, codebase-audit, large-migration, test-generation, documentation-update).
- Apply skills (security-first, test-driven, strict-types, docs-required) if relevant.

After starting, report the workflow ID and tell the user they can check status in .opencode/dynamic-workflows/runs/<id>/.
`
}

function ultraworkCommandTemplate(): string {
  return `---
description: Fire-and-forget dynamic workflow that runs until completion
agent: plan
subtask: false
---

Run a self-driving dynamic workflow that plans, delegates to specialist agents, verifies results, and synthesizes a final report. It does not stop until the objective is complete.

Objective: $ARGUMENTS

Use the dynamic_workflow_run tool with:
- objective: the user's goal
- background: true
- effort: "high"
- adversarial_review: true
- Set a clear stopping_condition.

This is the "just do it" command. Start the workflow and return immediately so the user knows it is running in the background.
`
}
