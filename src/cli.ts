#!/usr/bin/env node
import { resolve } from "node:path"
import { setupOpenCodePlugin, installWorkflowCommand, installUltraworkCommand } from "./install.js"

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2)
  const command = args[0] && !args[0].startsWith("-") ? args[0] : "help"

  switch (command) {
    case "setup":
      await setupCommand(args)
      break
    case "version":
      process.stdout.write(`oc-dw v${await readVersion()}\n`)
      break
    case "help":
    default:
      printHelp()
      if (command !== "help") process.exitCode = 1
  }
}

async function setupCommand(args: string[]): Promise<void> {
  const flags = parseFlags(args.slice(1))
  const cwd = resolve(getStringFlag(flags, "cwd") ?? process.cwd())
  const global = Boolean(flags["global"])

  const configPath = await setupOpenCodePlugin(cwd, global)
  const commandPath = await installWorkflowCommand(cwd, global)
  const ultraworkPath = await installUltraworkCommand(cwd, global)

  process.stdout.write(`OpenCode plugin configured at ${configPath}\n`)
  process.stdout.write(`Custom commands installed:\n`)
  process.stdout.write(`  /workflow  → ${commandPath}\n`)
  process.stdout.write(`  /ultrawork → ${ultraworkPath}\n`)
  process.stdout.write(`\nRestart OpenCode to use dynamic workflows.\n`)
}

async function readVersion(): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises")
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"))
    return pkg.version ?? "unknown"
  } catch {
    return "unknown"
  }
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("--")) continue
    const raw = arg.slice(2)
    const eq = raw.indexOf("=")
    const key = eq >= 0 ? raw.slice(0, eq) : raw
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined
    flags[key] = inline ?? (args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true)
  }
  return flags
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key]
  return typeof value === "string" ? value : undefined
}

function printHelp(): void {
  process.stdout.write(`oc-dw — OpenCode Dynamic Workflows

Usage:
  oc-dw setup [--cwd <path>] [--global]
  oc-dw version
  oc-dw help

Setup adds "oc-dw" to your OpenCode config and installs /workflow and /ultrawork
commands. After setup, restart OpenCode and use the tools directly inside the TUI.
`)
}

main(process.argv).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
