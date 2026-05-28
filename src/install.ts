import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

export async function installWorkflowCommand(cwd: string, global = false): Promise<string> {
  const base = global ? join(process.env.HOME ?? "~", ".config", "opencode") : join(resolve(cwd), ".opencode")
  const path = join(base, "commands", "workflow.md")
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, commandTemplate(), "utf8")
  return path
}

function commandTemplate(): string {
  return `---
description: Launch an OpenCode dynamic workflow
agent: plan
subtask: false
---

Launch a high-effort dynamic workflow for this objective:

$ARGUMENTS

Use the dynamic_workflow_run tool with background=true. If the tool is unavailable, tell the user to add this plugin to opencode.json:

{
  "plugin": ["opencode-dynamic-workflows/plugin"]
}
`
}
