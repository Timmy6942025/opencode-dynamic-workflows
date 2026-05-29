import type { ClientPromptOptions, PromptResult, ShellResult, WorkflowClient } from "./types.js"
import { promptResultFromRaw, splitModelId, unwrapResponse } from "./util.js"

function withContext<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((error) => {
    const original = error instanceof Error ? error.message : String(error)
    const enhanced = `[oc-dw] ${operation} failed.\n` +
      `  Original error: ${original}\n` +
      `  Tip: Ensure OpenCode is running and the plugin is loaded.`
    const err = new Error(enhanced)
    ;(err as Error & { cause?: unknown }).cause = error
    throw err
  })
}

export class SdkLikeWorkflowClient implements WorkflowClient {
  constructor(
    private readonly client: any,
    private readonly directory?: string,
  ) {}

  async health(): Promise<unknown> {
    if (this.client.global?.health) {
      return withContext("Health check", () => this.client.global.health())
    }
    return true
  }

  async providers(): Promise<unknown> {
    if (!this.client.config?.providers) return {}
    return this.client.config.providers()
  }

  async createSession(title: string, parent?: string): Promise<string> {
    const body: Record<string, unknown> = { title }
    if (parent) body.parentID = parent
    const response = await withContext("Create session", () =>
      this.client.session.create({ body, query: this.query() }),
    )
    const session = unwrapResponse<any>(response)
    if (!session?.id) throw new Error(`OpenCode did not return a session id for "${title}".`)
    return session.id
  }

  async initSession(sessionId: string): Promise<void> {
    await withContext("Init session", () =>
      this.client.session.init({ path: { id: sessionId }, query: this.query() }),
    )
  }

  async prompt(sessionId: string, text: string, options: ClientPromptOptions = {}): Promise<PromptResult> {
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text }],
    }
    if (options.noReply) body.noReply = true
    if (options.agent) body.agent = options.agent
    const model = splitModelId(options.model)
    if (model) body.model = model
    if (options.format) body.format = options.format
    const response = await withContext("Prompt session", () =>
      this.client.session.prompt({
        path: { id: sessionId },
        body,
        query: this.query(),
      }),
    )
    return promptResultFromRaw(response)
  }

  async shell(sessionId: string, command: string, timeoutMs?: number): Promise<ShellResult> {
    const body: Record<string, unknown> = { command, agent: "build" }
    if (timeoutMs) body.timeout = timeoutMs
    const response = await withContext("Shell command", () =>
      this.client.session.shell({
        path: { id: sessionId },
        body,
        query: this.query(),
      }),
    )
    const data = unwrapResponse<any>(response)
    return {
      command,
      exitCode: Number(data?.exitCode ?? data?.code ?? 0),
      stdout: String(data?.stdout ?? data?.output ?? ""),
      stderr: String(data?.stderr ?? ""),
      raw: response,
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    try {
      await this.client.session.delete({ path: { id: sessionId }, query: this.query() })
    } catch {
      // Cleanup should not fail the workflow.
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    try {
      await this.client.session.abort({ path: { id: sessionId }, query: this.query() })
    } catch {
      // Best-effort abort.
    }
  }

  async log(level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>): Promise<void> {
    if (!this.client.app?.log) return
    await this.client.app.log({
      body: {
        service: "opencode-dynamic-workflows",
        level,
        message,
        extra,
      },
    })
  }

  private query(): Record<string, string> | undefined {
    return this.directory ? { directory: this.directory } : undefined
  }
}
