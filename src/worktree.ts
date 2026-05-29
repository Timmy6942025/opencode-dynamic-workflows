import { execSync } from "node:child_process"
import { mkdir, readdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { Reporter } from "./types.js"

export async function createWorktree(cwd: string, name: string, reporter?: Reporter): Promise<string> {
  const worktreePath = join(resolve(cwd), `.opencode-worktrees/${name}`)
  await mkdir(worktreePath, { recursive: true })

  try {
    // Check if worktree already exists
    const existing = execSync("git worktree list --porcelain", { cwd, encoding: "utf8" })
    if (existing.includes(worktreePath)) {
      reporter?.info(`Worktree already exists at ${worktreePath}`)
      return worktreePath
    }

    execSync(`git worktree add -B ${name} "${worktreePath}"`, { cwd, encoding: "utf8" })
    reporter?.info(`Created git worktree at ${worktreePath}`)
  } catch (error) {
    // If not a git repo or git not available, just use the directory
    reporter?.warn(`Git worktree creation failed, using plain directory`, { error: String(error) })
  }

  return worktreePath
}

export async function cleanupWorktree(cwd: string, name: string, reporter?: Reporter): Promise<void> {
  const worktreePath = join(resolve(cwd), `.opencode-worktrees/${name}`)
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd, encoding: "utf8" })
    reporter?.info(`Removed git worktree ${name}`)
  } catch {
    // Best-effort cleanup
    try {
      await rm(worktreePath, { recursive: true, force: true })
      reporter?.info(`Removed worktree directory ${worktreePath}`)
    } catch {
      // Ignore
    }
  }
}

export async function listWorktrees(cwd: string): Promise<Array<{ name: string; path: string }>> {
  const worktreesDir = join(resolve(cwd), ".opencode-worktrees")
  try {
    const entries = await readdir(worktreesDir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: join(worktreesDir, e.name) }))
  } catch {
    return []
  }
}
