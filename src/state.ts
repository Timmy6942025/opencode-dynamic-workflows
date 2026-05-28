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
import { createWorkflowId, nowIso } from "./util.js"

export class FileWorkflowStore {
  readonly root: string

  constructor(cwd: string) {
    this.root = join(resolve(cwd), ".opencode", "dynamic-workflows")
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
      },
      phases: {},
      tasks: {},
      sessions: [],
    }
    await this.save(state)
    await this.setLatest(id)
    await this.appendEvent(id, {
      time: now,
      type: "workflow.created",
      message: "Workflow created",
      details: { objective: options.objective },
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
      }
      state.tasks[task.id] = taskState
    }
  }
  return state
}
