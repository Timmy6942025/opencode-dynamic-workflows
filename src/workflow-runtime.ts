import type {
  AgentResult,
  DynamicWorkflowOptions,
  ModelRole,
  Reporter,
  SpawnedAgent,
  VerificationResult,
  WorkflowClient,
  WorkflowState,
} from "./types.js"
import { resolveModel } from "./model-router.js"
import { jsonSchema, nowIso, splitModelId, truncate as truncateText } from "./util.js"

// ---------------------------------------------------------------------------
// Types local to the runtime
// ---------------------------------------------------------------------------

interface AgentInternal {
  id: string
  label: string
  prompt: string
  model?: string
  role: ModelRole
  startedAt: string
  completedAt?: string
  sessionId?: string
  output?: string
  error?: string
  status: "running" | "completed" | "failed"
  tokensUsed: number
  /** AbortController used to cancel pollForCompletion on timeout or explicit abort. */
  abort: AbortController
}

export interface SynthesisOptions {
  agents: SpawnedAgent[]
  prompt?: string
  model?: string
}

export interface AdversarialOptions {
  worker: SpawnedAgent
  verifierPrompt?: string
  verifierModel?: string
  rubric?: string[]
}

export interface TournamentOptions {
  agents: SpawnedAgent[]
  /** Return true if result `a` wins, false if result `b` wins. */
  judge: (a: AgentResult, b: AgentResult) => boolean
  rounds?: number
}

interface ShellResultLocal {
  command: string
  exitCode: number
  stdout: string
  stderr: string
}

/** Typed shape of messages returned by session.messages(). */
interface PollMessagePart {
  type?: string
  text?: string
}

interface PollMessage {
  role?: string
  parts?: PollMessagePart[]
  content?: PollMessagePart[]
  text?: string
}

type PollMessagesResponse = PollMessage[] | { messages?: PollMessage[] }

// ---------------------------------------------------------------------------
// Verification schema (reused from old runner)
// ---------------------------------------------------------------------------

const VERIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    pass: { type: "boolean", description: "True only if the output satisfies the criteria." },
    confidence: { type: "number", description: "0 to 1 confidence in this judgment." },
    issues: { type: "array", items: { type: "string" } },
    evidence: { type: "array", items: { type: "string" } },
  },
  required: ["pass", "confidence", "issues", "evidence"],
}

// ---------------------------------------------------------------------------
// WorkflowRuntime
// ---------------------------------------------------------------------------

export class WorkflowRuntime {
  /** Every agent spawned during script execution. */
  readonly agents: SpawnedAgent[] = []

  /** Map from SpawnedAgent.id to its internal state (for abort support). */
  private readonly agentMap = new Map<string, AgentInternal>()

  private totalTokensUsed = 0

  constructor(
    private readonly client: WorkflowClient,
    private readonly state: WorkflowState,
    private readonly options: DynamicWorkflowOptions,
    private readonly reporter: Reporter,
  ) {}

  // -----------------------------------------------------------------------
  // Core primitives
  // -----------------------------------------------------------------------

  /**
   * Spawn a new agent. Returns immediately with a handle; call `wait()` to
   * block until the agent finishes.
   */
  spawn(label: string, prompt: string, opts?: { model?: string; role?: ModelRole }): SpawnedAgent {
    const agent: AgentInternal = {
      id: `agent-${this.agents.length + 1}`,
      label,
      prompt,
      model: opts?.model,
      role: opts?.role ?? "worker",
      startedAt: nowIso(),
      status: "running",
      tokensUsed: 0,
      abort: new AbortController(),
    }
    const resultPromise = this.runAgent(agent)
    const spawned: SpawnedAgent = {
      id: agent.id,
      label: agent.label,
      result: resultPromise,
    }
    this.agents.push(spawned)
    this.agentMap.set(agent.id, agent)
    return spawned
  }

  /**
   * Block until one or more agents finish. Always returns an array.
   */
  async wait(agents: SpawnedAgent | SpawnedAgent[], timeoutMs?: number): Promise<AgentResult[]> {
    const list = Array.isArray(agents) ? agents : [agents]
    const tasks = list.map(async (agent) => {
      if (timeoutMs && timeoutMs > 0) {
        return Promise.race([
          agent.result,
          new Promise<AgentResult>((resolve) => {
            const timer = setTimeout(() => {
              // Abort the polling loop so it doesn't linger
              const internal = this.agentMap.get(agent.id)
              if (internal) this.abortAgent(internal)
              resolve({ text: "", error: "timeout", tokensUsed: 0 })
            }, timeoutMs)
            // Prevent timer from keeping Node alive if result wins the race
            if (typeof timer === "object" && "unref" in timer) timer.unref()
          }),
        ])
      }
      return agent.result
    })
    return Promise.all(tasks)
  }

  /**
   * Spawn several agents and wait for all of them. Convenience wrapper.
   */
  async parallel(
    defs: Array<{ label: string; prompt: string; model?: string; role?: ModelRole }>,
  ): Promise<AgentResult[]> {
    const agents = defs.map((d) => this.spawn(d.label, d.prompt, d))
    return this.wait(agents)
  }

  /**
   * Fan-out over an array: spawn one agent per element with a factory
   * function, then wait for all. Respects the concurrency limit by batching.
   */
  async forEach<T>(
    items: T[],
    fn: (item: T, index: number) => { label: string; prompt: string; model?: string; role?: ModelRole },
  ): Promise<AgentResult[]> {
    const concurrency = Math.max(1, this.options.concurrency)
    const results: AgentResult[] = []
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency)
      const batchResults = await this.parallel(batch.map((item, j) => fn(item, i + j)))
      results.push(...batchResults)
    }
    return results
  }

  /**
   * Same as forEach but preserves the mapping so you can correlate results
   * back to inputs.
   */
  async map<T>(
    items: T[],
    fn: (item: T, index: number) => { label: string; prompt: string; model?: string; role?: ModelRole },
  ): Promise<Array<{ item: T; result: AgentResult }>> {
    const concurrency = Math.max(1, this.options.concurrency)
    const results: Array<{ item: T; result: AgentResult }> = []
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency)
      const defs = batch.map((item, j) => fn(item, i + j))
      const agents = defs.map((def) => this.spawn(def.label, def.prompt, def))
      const batchResults = await this.wait(agents)
      for (let j = 0; j < batch.length; j++) {
        results.push({ item: batch[j], result: batchResults[j] })
      }
    }
    return results
  }

  // -----------------------------------------------------------------------
  // Higher-order patterns
  // -----------------------------------------------------------------------

  /**
   * Synthesize: combine multiple agent outputs into one coherent result.
   */
  async synthesize(opts: SynthesisOptions): Promise<AgentResult> {
    const model = opts.model ?? resolveModel("synthesizer", undefined, this.options.models)

    // Wait for all agents first
    const results = await this.wait(opts.agents)
    const combinedText = results.map((r, i) => `### ${opts.agents[i].label}\n\n${r.text}`).join("\n\n---\n\n")

    const prompt = [
      opts.prompt ?? "Synthesize the following agent outputs into one coherent, comprehensive result.",
      "",
      combinedText,
    ].join("\n")

    return this.runSingleAgent("Synthesizer", prompt, model, "synthesizer")
  }

  /**
   * Adversarial verification: run a worker, then have a verifier check it.
   */
  async adversarial(opts: AdversarialOptions): Promise<{ worker: AgentResult; verification: VerificationResult }> {
    const workerResult = await this.wait(opts.worker)

    const verifierModel = opts.verifierModel ?? resolveModel("verifier", undefined, this.options.models)
    const criteria = opts.rubric?.map((r) => `- ${r}`).join("\n") ?? "- Output is correct and complete"

    const verifyPrompt = [
      "You are an independent verifier. Judge the worker output against the criteria.",
      "Prefer false negatives over accepting unsupported claims.",
      "",
      `Criteria:\n${criteria}`,
      "",
      `Worker output:\n${truncateText(workerResult[0].text, 16_000)}`,
      "",
      opts.verifierPrompt ?? "Return the structured verification result.",
    ].join("\n")

    const sessionId = await this.client.createSession(`dw:${this.state.id}:adversarial-verifier`)
    const raw = await this.client.prompt(sessionId, verifyPrompt, {
      model: splitModelId(verifierModel),
      agent: "plan",
      format: jsonSchema(VERIFICATION_SCHEMA, 2),
    })
    const tokensUsed = estimateTokens(raw.text)
    this.totalTokensUsed += tokensUsed
    if (this.options.cleanUpSessions) await this.client.deleteSession(sessionId)

    const structured = raw.structured as Record<string, unknown> | undefined
    const verification: VerificationResult = structured
      ? {
          pass: Boolean(structured.pass),
          confidence: clamp(Number(structured.confidence), 0, 1),
          issues: toStringArray(structured.issues),
          evidence: toStringArray(structured.evidence),
          rawText: raw.text,
          tokensUsed,
          model: verifierModel,
        }
      : {
          pass: /pass(ed)?|satisf/i.test(raw.text),
          confidence: 0.4,
          issues: [truncateText(raw.text, 800)],
          evidence: [],
          rawText: raw.text,
          tokensUsed,
          model: verifierModel,
        }

    return { worker: workerResult[0], verification }
  }

  /**
   * Tournament: bracket-style competition between agents.
   * A judge function picks the winner of each head-to-head round.
   */
  async tournament(opts: TournamentOptions): Promise<AgentResult> {
    const results = await this.wait(opts.agents)
    let surviving = [...opts.agents.map((a, i) => ({ agent: a, result: results[i] }))]

    while (surviving.length > 1) {
      const nextRound: Array<{ agent: SpawnedAgent; result: AgentResult }> = []
      for (let i = 0; i < surviving.length; i += 2) {
        if (i + 1 >= surviving.length) {
          nextRound.push(surviving[i])
          continue
        }
        const aWins = opts.judge(surviving[i].result, surviving[i + 1].result)
        nextRound.push(aWins ? surviving[i] : surviving[i + 1])
      }
      surviving = nextRound
    }

    return surviving[0].result
  }

  /**
   * Loop: keep spawning agents until a condition is met or max iterations
   * reached.
   */
  async loop(
    fn: (iteration: number, previous?: AgentResult) => { label: string; prompt: string; model?: string; role?: ModelRole },
    until: (result: AgentResult, iteration: number) => boolean,
    maxIterations = 5,
  ): Promise<AgentResult[]> {
    const collected: AgentResult[] = []
    for (let i = 0; i < maxIterations; i++) {
      const def = fn(i, collected.length > 0 ? collected[collected.length - 1] : undefined)
      const agent = this.spawn(def.label, def.prompt, def)
      const [result] = await this.wait(agent)
      collected.push(result)
      if (until(result, i)) break
    }
    return collected
  }

  // -----------------------------------------------------------------------
  // Utilities available to scripts
  // -----------------------------------------------------------------------

  async shell(command: string, timeoutMs?: number): Promise<ShellResultLocal> {
    const sessionId = await this.client.createSession(`dw:${this.state.id}:shell`)
    const result = await this.client.shell(sessionId, command, timeoutMs ?? 15 * 60 * 1000)
    this.totalTokensUsed += estimateTokens(result.stdout + result.stderr)
    if (this.options.cleanUpSessions) await this.client.deleteSession(sessionId)
    return result
  }

  ask(question: string): Promise<string> {
    // In a plugin context we can't directly prompt the user, so we return the
    // question as the answer (the host agent is expected to relay it).
    this.reporter.info(`[workflow:ask] ${question}`)
    return Promise.resolve(question)
  }

  log(level: "info" | "warn" | "error", message: string): void {
    const fn = level === "error" ? this.reporter.error : level === "warn" ? this.reporter.warn : this.reporter.info
    fn(`[workflow] ${message}`)
  }

  truncate(text: string, max: number): string {
    return truncateText(text, max)
  }

  // -----------------------------------------------------------------------
  // Aggregates
  // -----------------------------------------------------------------------

  getTotalTokensUsed(): number {
    return this.totalTokensUsed
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Abort an agent's polling loop so it doesn't linger after a timeout.
   */
  private abortAgent(agent: AgentInternal): void {
    agent.abort.abort()
  }

  private async runAgent(agent: AgentInternal): Promise<AgentResult> {
    try {
      const model = agent.model ?? resolveModel(agent.role, undefined, this.options.models)
      const sessionId = await this.client.createSession(`dw:${this.state.id}:${agent.id}`)
      agent.sessionId = sessionId

      const agentType = agent.role === "scout" ? "explore"
        : agent.role === "critic" || agent.role === "adversary" ? "plan"
        : "build"
      const modelObj = splitModelId(model)
      const promptOpts = {
        ...(modelObj ? { model: modelObj } : {}),
        agent: agentType,
      }

      // Use promptAsync for fire-and-forget: OpenCode handles session lifecycle
      await this.client.promptAsync(sessionId, agent.prompt, promptOpts)

      // Poll for completion by checking messages
      const result = await this.pollForCompletion(sessionId, agent)

      const tokensUsed = estimateTokens(result.text)
      agent.completedAt = nowIso()
      agent.output = result.text
      agent.status = "completed"
      agent.tokensUsed = tokensUsed
      this.totalTokensUsed += tokensUsed

      if (this.options.cleanUpSessions) await this.client.deleteSession(sessionId)

      return { text: result.text, tokensUsed, model }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      agent.completedAt = nowIso()
      agent.error = message
      agent.status = "failed"
      return { text: "", error: message, tokensUsed: 0 }
    }
  }

  /**
   * Poll session messages until we get a completed assistant response.
   * This lets OpenCode handle the agent lifecycle natively.
   */
  private async pollForCompletion(sessionId: string, agent: AgentInternal): Promise<{ text: string }> {
    const pollIntervalMs = 1_000
    const maxPollMs = 15 * 60 * 1000 // 15 min safety net
    const deadline = Date.now() + maxPollMs

    while (Date.now() < deadline && !agent.abort.signal.aborted) {
      const raw = await this.client.messages(sessionId)
      const data = raw as PollMessagesResponse
      const messages = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : []

      // Look for the last assistant message with text content
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]
        if (msg?.role !== "assistant") continue
        const parts = msg?.parts ?? msg?.content ?? []
        const text = Array.isArray(parts)
          ? parts
              .filter((p) => p?.type === "text" && typeof p.text === "string")
              .map((p) => p.text as string)
              .join("\n")
          : typeof msg?.text === "string" ? msg.text : ""
        if (text) return { text }
      }

      // Use a cancellable delay so we exit promptly when aborted
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs)
        if (typeof timer === "object" && "unref" in timer) timer.unref()
        agent.abort.signal.addEventListener("abort", () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
    }

    if (agent.abort.signal.aborted) {
      throw new Error(`Agent ${agent.id} was aborted.`)
    }
    throw new Error(`Agent ${agent.id} timed out after ${maxPollMs}ms waiting for response.`)
  }

  private async runSingleAgent(label: string, prompt: string, model: string | undefined, role: ModelRole): Promise<AgentResult> {
    const sessionId = await this.client.createSession(`dw:${this.state.id}:${label.toLowerCase().replace(/\s+/g, "-")}`)
    const resolvedModel = model ?? resolveModel(role, undefined, this.options.models)
    const result = await this.client.prompt(sessionId, prompt, {
      model: splitModelId(resolvedModel),
      agent: role === "scout" ? "explore" : "plan",
    })
    const tokensUsed = estimateTokens(result.text)
    this.totalTokensUsed += tokensUsed
    if (this.options.cleanUpSessions) await this.client.deleteSession(sessionId)
    return { text: result.text, tokensUsed, model }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4)
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : 0
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((i): i is string => typeof i === "string") : []
}
