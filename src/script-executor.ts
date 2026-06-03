import { createContext, runInContext } from "node:vm"

import type { DynamicWorkflowOptions, Reporter, WorkflowClient, WorkflowState } from "./types.js"
import { WorkflowRuntime } from "./workflow-runtime.js"
import { nowIso, toErrorMessage } from "./util.js"

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ScriptResult {
  /** Whatever the script returned (stringified if not a string). */
  output: string
  /** Error message if the script threw. */
  error?: string
  /** Tokens used across all spawned agents. */
  tokensUsed: number
  /** Wall-clock duration of script execution. */
  durationMs: number
  /** Reference to the runtime so the caller can inspect agents[]. */
  runtime: WorkflowRuntime
}

// ---------------------------------------------------------------------------
// ScriptExecutor
// ---------------------------------------------------------------------------

export class ScriptExecutor {
  constructor(
    private readonly client: WorkflowClient,
    private readonly options: DynamicWorkflowOptions,
    private readonly reporter: Reporter,
  ) {}

  /**
   * Execute a workflow script and return the result.
   *
   * The script is compiled inside a Node.js `vm` sandbox with the workflow
   * API injected as globals (`spawn`, `wait`, `parallel`, etc.).
   */
  async execute(state: WorkflowState, script: string): Promise<ScriptResult> {
    const runtime = new WorkflowRuntime(this.client, state, this.options, this.reporter)
    const startedAt = Date.now()

    // ---- Build the API object the script receives ----
    const api = {
      // Core primitives
      spawn: runtime.spawn.bind(runtime),
      wait: runtime.wait.bind(runtime),
      parallel: runtime.parallel.bind(runtime),

      // Fan-out helpers
      forEach: runtime.forEach.bind(runtime),
      map: runtime.map.bind(runtime),

      // Higher-order patterns
      synthesize: runtime.synthesize.bind(runtime),
      adversarial: runtime.adversarial.bind(runtime),
      tournament: runtime.tournament.bind(runtime),
      loop: runtime.loop.bind(runtime),

      // Utilities
      shell: runtime.shell.bind(runtime),
      ask: runtime.ask.bind(runtime),
      log: runtime.log.bind(runtime),
      truncate: runtime.truncate.bind(runtime),

      // Constants
      objective: state.objective,
      stoppingCondition: state.stoppingCondition ?? "",
      maxAgents: this.options.maxAgents,
      concurrency: this.options.concurrency,
      cwd: state.cwd,
      tokenBudget: this.options.tokenBudget ?? 0,
      skills: this.options.skills,

      // Standard libraries (useful for data processing)
      JSON,
      Math,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Date,
      RegExp,
      Map,
      Set,
      Promise,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
    }

    // ---- Compile and run ----
    const wrappedScript = `(async () => {\n${script}\n})()`
    const timeoutMs = 30 * 60 * 1000 // 30 minute safety net

    try {
      const context = createContext({
        ...api,
        console: {
          log: (...args: unknown[]) => this.reporter.info(`[script:log] ${args.map(String).join(" ")}`),
          warn: (...args: unknown[]) => this.reporter.warn(`[script:warn] ${args.map(String).join(" ")}`),
          error: (...args: unknown[]) => this.reporter.error(`[script:error] ${args.map(String).join(" ")}`),
        },
        // Allow common globals scripts might use
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
      })

      const resultPromise = runInContext(wrappedScript, context, {
        timeout: timeoutMs,
        displayErrors: true,
      })

      const output = await resultPromise
      const durationMs = Date.now() - startedAt

      return {
        output: typeof output === "string" ? output : output != null ? JSON.stringify(output, null, 2) : "",
        tokensUsed: runtime.getTotalTokensUsed(),
        durationMs,
        runtime,
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt
      return {
        output: "",
        error: toErrorMessage(error),
        tokensUsed: runtime.getTotalTokensUsed(),
        durationMs,
        runtime,
      }
    }
  }
}
