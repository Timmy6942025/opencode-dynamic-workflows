import type { ClientPromptOptions, PromptResult, ShellResult, WorkflowClient } from "./types.js"
import { promptResultFromRaw, splitModelId, unwrapResponse } from "./util.js"

interface RawOpencodeServer {
  close(): Promise<void> | void
}

export interface CreateWorkflowClientOptions {
  baseUrl?: string
  startServer?: boolean
  hostname?: string
  port?: number
  directory?: string
  config?: Record<string, unknown>
}

export async function createWorkflowClient(options: CreateWorkflowClientOptions): Promise<WorkflowClient> {
  const sdk = await import("@opencode-ai/sdk")
  if (options.startServer) {
    const instance = await sdk.createOpencode({
      hostname: options.hostname ?? "127.0.0.1",
      port: options.port ?? 4096,
      config: options.config ?? {},
      timeout: 10_000,
    })
    return new SdkLikeWorkflowClient(instance.client, instance.server, options.directory)
  }

  const client = sdk.createOpencodeClient({
    baseUrl: options.baseUrl ?? "http://localhost:4096",
    throwOnError: true,
    responseStyle: "fields",
    directory: options.directory,
  })
  return new SdkLikeWorkflowClient(client, undefined, options.directory)
}

export class SdkLikeWorkflowClient implements WorkflowClient {
  constructor(
    private readonly client: any,
    private readonly server?: RawOpencodeServer,
    private readonly directory?: string,
  ) {}

  async health(): Promise<unknown> {
    return this.client.global?.health ? this.client.global.health() : true
  }

  async providers(): Promise<unknown> {
    if (!this.client.config?.providers) return {}
    return this.client.config.providers()
  }

  async createSession(title: string, parent?: string): Promise<string> {
    const body: Record<string, unknown> = { title }
    if (parent) body.parentID = parent
    const response = await this.client.session.create({ body, query: this.query() })
    const session = unwrapResponse<any>(response)
    if (!session?.id) throw new Error(`OpenCode did not return a session id for "${title}".`)
    return session.id
  }

  async initSession(sessionId: string): Promise<void> {
    await this.client.session.init({ path: { id: sessionId }, query: this.query() })
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
    const response = await this.client.session.prompt({
      path: { id: sessionId },
      body,
      query: this.query(),
    })
    return promptResultFromRaw(response)
  }

  async shell(sessionId: string, command: string, timeoutMs?: number): Promise<ShellResult> {
    const body: Record<string, unknown> = { command, agent: "build" }
    if (timeoutMs) body.timeout = timeoutMs
    const response = await this.client.session.shell({
      path: { id: sessionId },
      body,
      query: this.query(),
    })
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

  async close(): Promise<void> {
    await this.server?.close()
  }

  private query(): Record<string, string> | undefined {
    return this.directory ? { directory: this.directory } : undefined
  }
}
