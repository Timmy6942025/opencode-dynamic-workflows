import type { ClientPromptOptions, PromptResult, ShellResult, WorkflowClient } from "./types.js"
import { promptResultFromRaw, unwrapResponse } from "./util.js"

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

/**
 * WorkflowClient backed by OpenCode's native SDK client (`ctx.client`).
 *
 * Uses the SDK's typed request objects directly — no manual body construction.
 * The `client` parameter is `ctx.client` from the Plugin context (OpencodeClient).
 */
export class SdkLikeWorkflowClient implements WorkflowClient {
  constructor(
    private readonly client: any,
    private readonly directory?: string,
  ) {}

  async createSession(title: string, parent?: string): Promise<string> {
    const response = await withContext("Create session", () =>
      this.client.session.create({
        body: { title, ...(parent ? { parentID: parent } : {}) },
        query: this.query(),
      }),
    )
    const session = unwrapResponse<any>(response)
    if (!session?.id) throw new Error(`OpenCode did not return a session id for "${title}".`)
    return session.id
  }

  async prompt(sessionId: string, text: string, options: ClientPromptOptions = {}): Promise<PromptResult> {
    const response = await withContext("Prompt session", () =>
      this.client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
          ...(options.noReply ? { noReply: true } : {}),
          ...(options.agent ? { agent: options.agent } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.format ? { format: options.format } : {}),
        },
        query: this.query(),
      }),
    )
    return promptResultFromRaw(response)
  }

  async promptAsync(sessionId: string, text: string, options: ClientPromptOptions = {}): Promise<void> {
    await withContext("Prompt session (async)", () =>
      this.client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
          ...(options.noReply ? { noReply: true } : {}),
          ...(options.agent ? { agent: options.agent } : {}),
          ...(options.model ? { model: options.model } : {}),
        },
        query: this.query(),
      }),
    )
  }

  async messages(sessionId: string): Promise<unknown> {
    const response = await withContext("Get messages", () =>
      this.client.session.messages({
        path: { id: sessionId },
        query: this.query(),
      }),
    )
    return unwrapResponse(response)
  }

  async shell(sessionId: string, command: string, timeoutMs?: number): Promise<ShellResult> {
    const response = await withContext("Shell command", () =>
      this.client.session.shell({
        path: { id: sessionId },
        body: {
          command,
          agent: "build",
        },
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
        service: "oc-dw",
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
