import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

export async function installWorkflowCommand(cwd: string, global = false): Promise<string> {
  const base = global ? join(homedir(), ".config", "opencode") : join(resolve(cwd), ".opencode")
  const path = join(base, "commands", "workflow.md")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, commandTemplate(), "utf8")
  return path
}

export async function setupOpenCodePlugin(cwd: string, global = false): Promise<string> {
  const configDir = global
    ? join(homedir(), ".config", "opencode")
    : join(resolve(cwd), ".opencode")
  const configPath = join(configDir, "opencode.json")

  let config: { plugin?: unknown } = {}
  if (existsSync(configPath)) {
    try {
      const raw = await readFile(configPath, "utf8")
      config = JSON.parse(raw) as { plugin?: unknown }
    } catch {
      config = {}
    }
  }

  const existing = Array.isArray(config.plugin) ? config.plugin : []
  const plugins = new Set(existing)
  plugins.add("oc-dw")
  config.plugin = [...plugins]

  await mkdir(configDir, { recursive: true })
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")

  return configPath
}

function commandTemplate(): string {
  return `---
description: Launch an OpenCode dynamic workflow
agent: plan
subtask: false
---

Launch a high-effort dynamic workflow for this objective:

$ARGUMENTS

Use the dynamic_workflow_run tool with background=true. If the tool is unavailable, tell the user to run oc-dw setup.
`
}
