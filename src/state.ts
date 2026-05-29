import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type {
  DynamicWorkflowOptions,
  PhaseRunState,
  TaskRunState,
  WorkflowEvent,
  WorkflowPlan,
  WorkflowState,
} from "./types.js"
import { createWorkflowId, nowIso, slugify } from "./util.js"

export class FileWorkflowStore {
  readonly root: string
  private locks = new Map<string, Promise<void>>()

  constructor(cwd: string) {
    this.root = join(resolve(cwd), ".opencode", "dynamic-workflows")
  }

  private async acquireLock(workflowId: string): Promise<() => void> {
    while (this.locks.has(workflowId)) {
      await this.locks.get(workflowId)
    }
    let release!: () => void
    const promise = new Promise<void>((resolve) => { release = resolve })
    this.locks.set(workflowId, promise)
    return () => {
      this.locks.delete(workflowId)
      release()
    }
  }

  async mutateState(workflowId: string, mutator: (state: WorkflowState) => void): Promise<WorkflowState> {
    const release = await this.acquireLock(workflowId)
    try {
      const state = await this.load(workflowId)
      mutator(state)
      await this.save(state)
      return state
    } finally {
      release()
    }
  }

  workflowsDir(): string {
    return join(this.root, "workflows")
  }

  templatesDir(): string {
    return join(this.root, "templates")
  }

  skillsDir(): string {
    return join(this.root, "skills")
  }

  cacheDir(workflowId: string): string {
    return join(this.runDir(workflowId), "cache")
  }

  progressPath(workflowId: string): string {
    return join(this.runDir(workflowId), "progress.jsonl")
  }

  runDir(workflowId: string): string {
    return join(this.root, "runs", workflowId)
  }

  statePath(workflowId: string): string {
    return join(this.runDir(workflowId), "state.json")
  }

  eventsPath(workflowId: string): string {
    return join(this.runDir(workflowId), "events.jsonl")
  }

  latestPath(): string {
    return join(this.root, "latest")
  }

  async create(options: DynamicWorkflowOptions): Promise<WorkflowState> {
    const id = options.workflowId ?? createWorkflowId(options.objective)
    const now = nowIso()
    const state: WorkflowState = {
      id,
      objective: options.objective,
      stoppingCondition: options.stoppingCondition,
      cwd: resolve(options.cwd),
      status: "planning",
      createdAt: now,
      updatedAt: now,
      options: {
        maxAgents: options.maxAgents,
        concurrency: options.concurrency,
        verificationRounds: options.verificationRounds,
        retryLimit: options.retryLimit,
        qualityGateTimeoutMs: options.qualityGateTimeoutMs,
        cleanUpSessions: options.cleanUpSessions,
        failFast: options.failFast,
        maxSummaryInputChars: options.maxSummaryInputChars,
        models: options.models,
        metadata: options.metadata,
        orchestrationMode: options.orchestrationMode,
        effortLevel: options.effortLevel,
        permissionMode: options.permissionMode,
        requireApproval: options.requireApproval,
        adversarialReview: options.adversarialReview,
        convergenceThreshold: options.convergenceThreshold,
        generateOrchestrationScript: options.generateOrchestrationScript,
        saveWorkflow: options.saveWorkflow,
        workflowName: options.workflowName,
        useWorktree: options.useWorktree,
        skills: options.skills,
        template: options.template,
        scoutFirst: options.scoutFirst ?? false,
        tokenBudget: options.tokenBudget,
        contextOffloadThreshold: options.contextOffloadThreshold,
        progressReportIntervalMs: options.progressReportIntervalMs,
      },
      phases: {},
      tasks: {},
      sessions: [],
      totalTokensUsed: 0,
      progressReports: [],
      isTemplate: false,
      convergenceResults: {},
    }
    await this.save(state)
    await this.setLatest(id)
    await this.appendEvent(id, {
      time: now,
      type: "workflow.created",
      message: "Workflow created",
      details: { objective: options.objective, effortLevel: options.effortLevel, orchestrationMode: options.orchestrationMode },
    })
    return state
  }

  async load(workflowId: string): Promise<WorkflowState> {
    const raw = await readFile(this.statePath(workflowId), "utf8")
    return JSON.parse(raw) as WorkflowState
  }

  async loadLatest(): Promise<WorkflowState> {
    const id = (await readFile(this.latestPath(), "utf8")).trim()
    if (!id) throw new Error("No latest workflow recorded.")
    return this.load(id)
  }

  async list(): Promise<WorkflowState[]> {
    const runsDir = join(this.root, "runs")
    let ids: string[] = []
    try {
      ids = await readdir(runsDir)
    } catch {
      return []
    }
    const states = await Promise.all(
      ids.map(async (id) => {
        try {
          return await this.load(id)
        } catch {
          return undefined
        }
      }),
    )
    return states
      .filter((state): state is WorkflowState => Boolean(state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async save(state: WorkflowState): Promise<void> {
    state.updatedAt = nowIso()
    const path = this.statePath(state.id)
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp-${process.pid}`
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8")
    await rename(temp, path)
  }

  async setLatest(workflowId: string): Promise<void> {
    const path = this.latestPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${workflowId}\n`, "utf8")
  }

  async appendEvent(workflowId: string, event: WorkflowEvent): Promise<void> {
    const path = this.eventsPath(workflowId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" })
  }

  async writeArtifact(workflowId: string, relativePath: string, content: string): Promise<string> {
    const path = join(this.runDir(workflowId), relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, "utf8")
    return path
  }

  async saveProgressReport(workflowId: string, report: import("./types.js").ProgressReport): Promise<void> {
    const path = this.progressPath(workflowId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(report)}\n`, { encoding: "utf8", flag: "a" })
  }

  async readCachedResult(workflowId: string, cacheKey: string): Promise<string | undefined> {
    const path = join(this.cacheDir(workflowId), `${cacheKey}.json`)
    try {
      return await readFile(path, "utf8")
    } catch {
      return undefined
    }
  }

  async writeCachedResult(workflowId: string, cacheKey: string, content: string): Promise<void> {
    const dir = this.cacheDir(workflowId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${cacheKey}.json`), content, "utf8")
  }

  async saveWorkflowTemplate(workflowId: string, name: string, state: WorkflowState): Promise<string> {
    const dir = this.workflowsDir()
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${slugify(name)}.json`)
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
    return path
  }

  async listWorkflowTemplates(): Promise<Array<{ name: string; path: string }>> {
    const dir = this.workflowsDir()
    let files: string[] = []
    try {
      files = await readdir(dir)
    } catch {
      return []
    }
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ name: f.replace(/\.json$/, ""), path: join(dir, f) }))
  }

  async loadWorkflowTemplate(name: string): Promise<WorkflowState | undefined> {
    const path = join(this.workflowsDir(), `${slugify(name)}.json`)
    try {
      const raw = await readFile(path, "utf8")
      return JSON.parse(raw) as WorkflowState
    } catch {
      return undefined
    }
  }
}

export function initializePlanState(state: WorkflowState, plan: WorkflowPlan): WorkflowState {
  state.plan = plan
  state.phases = {}
  state.tasks = {}
  for (const phase of plan.phases) {
    const phaseState: PhaseRunState = {
      phaseId: phase.id,
      status: "pending",
      gateResults: [],
      tokensUsed: 0,
    }
    state.phases[phase.id] = phaseState
    for (const task of phase.tasks) {
      const taskState: TaskRunState = {
        taskId: task.id,
        phaseId: phase.id,
        status: "pending",
        attempts: [],
        verified: false,
        updatedAt: nowIso(),
        tokensUsed: 0,
      }
      state.tasks[task.id] = taskState
    }
  }
  return state
}
