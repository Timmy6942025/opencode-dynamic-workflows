import type { ClientPromptOptions, PromptResult, ShellResult, WorkflowClient } from "./types.js"
import { promptResultFromRaw, splitModelId, unwrapResponse } from "./util.js"
import { checkPortOpen, parseHostPort, sleep } from "./net-util.js"
import { updateServerStatus } from "./server-status.js"

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

async function tryStartServer(
  sdk: any,
  options: CreateWorkflowClientOptions,
): Promise<{ client: any; server: RawOpencodeServer | undefined; baseUrl: string }> {
  const hostname = options.hostname ?? "127.0.0.1"
  const port = options.port ?? 4096
  const baseUrl = options.baseUrl ?? `http://${hostname}:${port}`

  updateServerStatus({ stage: "starting", message: `Auto-starting OpenCode server at ${baseUrl}...`, baseUrl, startedAt: Date.now() })
  process.stderr.write(`[oc-dw] No OpenCode server found at ${baseUrl}. Auto-starting local server...\n`)
  try {
    const instance = await sdk.createOpencode({
      hostname,
      port,
      config: options.config ?? {},
      timeout: 10_000,
    })

    // Poll until the port accepts connections (up to 5s)
    updateServerStatus({ stage: "polling", message: `Waiting for server to become ready at ${baseUrl}...`, baseUrl })
    const { host, port: p } = parseHostPort(baseUrl)
    for (let i = 0; i < 25; i++) {
      if (await checkPortOpen(host, p, 300)) {
        updateServerStatus({ stage: "ready", message: `OpenCode server ready at ${baseUrl}`, baseUrl })
        process.stderr.write(`[oc-dw] OpenCode server ready at ${baseUrl}\n`)
        return { client: instance.client, server: instance.server, baseUrl }
      }
      await sleep(200)
    }
    updateServerStatus({ stage: "ready", message: `OpenCode server at ${baseUrl} started (port check timed out but proceeding)`, baseUrl })
    process.stderr.write(`[oc-dw] Warning: server started but port did not become ready within 5s. Proceeding anyway.\n`)
    return { client: instance.client, server: instance.server, baseUrl }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    updateServerStatus({ stage: "failed", message: `Failed to auto-start server at ${baseUrl}: ${msg}`, baseUrl, error: msg })
    throw new Error(
      `Failed to auto-start OpenCode server at ${baseUrl}.\n` +
        `Reason: ${msg}\n` +
        `\nTo fix this, either:\n` +
        `  1. Start an OpenCode server manually (e.g. \`opencode start\`)\n` +
        `  2. Pass --start-server to let oc-dw start one automatically\n` +
        `  3. Pass --base-url <url> to point to an existing server`,
    )
  }
}

export async function createWorkflowClient(options: CreateWorkflowClientOptions): Promise<WorkflowClient> {
  const sdk = await import("@opencode-ai/sdk")
  const baseUrl = options.baseUrl ?? "http://localhost:4096"

  if (options.startServer === true) {
    const { client, server, baseUrl: actualBaseUrl } = await tryStartServer(sdk, options)
    return new SdkLikeWorkflowClient(client, server, options.directory, actualBaseUrl)
  }

  updateServerStatus({ stage: "checking", message: `Checking reachability of ${baseUrl}...`, baseUrl, startedAt: Date.now() })
  const { host, port } = parseHostPort(baseUrl)
  const reachable = await checkPortOpen(host, port)
  if (reachable) {
    updateServerStatus({ stage: "ready", message: `OpenCode server connected at ${baseUrl}`, baseUrl })
    const client = sdk.createOpencodeClient({
      baseUrl,
      throwOnError: true,
      responseStyle: "fields",
      directory: options.directory,
    })
    return new SdkLikeWorkflowClient(client, undefined, options.directory, baseUrl)
  }

  if (options.startServer === false) {
    updateServerStatus({ stage: "failed", message: `No OpenCode server reachable at ${baseUrl}`, baseUrl })
    throw new Error(
      `No OpenCode server reachable at ${baseUrl} and --start-server was not set.\n` +
        `Start a server with \`opencode start\` or pass --start-server to auto-start.`,
    )
  }

  // Auto-start if not explicitly disabled
  const { client, server, baseUrl: actualBaseUrl } = await tryStartServer(sdk, options)
  return new SdkLikeWorkflowClient(client, server, options.directory, actualBaseUrl)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && "then" in value && typeof (value as PromiseLike<unknown>).then === "function"
}

function withContext<T>(operation: string, url: string, fn: () => Promise<T>): Promise<T> {
  return fn().catch((error) => {
    const original = error instanceof Error ? error.message : String(error)
    const enhanced = `[oc-dw] ${operation} failed.\n` +
      `  Server: ${url}\n` +
      `  Original error: ${original}\n` +
      `  Tip: Ensure an OpenCode server is running (\`opencode start\`) or pass --start-server.`
    const err = new Error(enhanced)
    ;(err as Error & { cause?: unknown }).cause = error
    throw err
  })
}

export class SdkLikeWorkflowClient implements WorkflowClient {
  constructor(
    private readonly client: any,
    private readonly server?: RawOpencodeServer,
    private readonly directory?: string,
    private readonly baseUrl: string = "http://localhost:4096",
  ) {}

  async health(): Promise<unknown> {
    if (this.client.global?.health) {
      return withContext("Health check", this.baseUrl, () => this.client.global.health())
    }
    // For client-only mode, do a lightweight TCP reachability check
    const { host, port } = parseHostPort(this.baseUrl)
    return checkPortOpen(host, port, 2_000)
  }

  async providers(): Promise<unknown> {
    if (!this.client.config?.providers) return {}
    return this.client.config.providers()
  }

  async createSession(title: string, parent?: string): Promise<string> {
    const body: Record<string, unknown> = { title }
    if (parent) body.parentID = parent
    const response = await withContext("Create session", this.baseUrl, () =>
      this.client.session.create({ body, query: this.query() }),
    )
    const session = unwrapResponse<any>(response)
    if (!session?.id) throw new Error(`OpenCode did not return a session id for "${title}".`)
    return session.id
  }

  async initSession(sessionId: string): Promise<void> {
    await withContext("Init session", this.baseUrl, () =>
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
    const response = await withContext("Prompt session", this.baseUrl, () =>
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
    const response = await withContext("Shell command", this.baseUrl, () =>
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

  async close(): Promise<void> {
    if (!this.server) return
    try {
      const result = this.server.close()
      if (isPromiseLike(result)) {
        await result
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  private query(): Record<string, string> | undefined {
    return this.directory ? { directory: this.directory } : undefined
  }
}
