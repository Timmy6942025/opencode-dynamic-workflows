import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { join, extname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { FileWorkflowStore } from "./state.js"
import { checkPortOpen, parseHostPort } from "./net-util.js"
import { getServerStatus } from "./server-status.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
}

export interface DashboardServerOptions {
  port?: number
  store: FileWorkflowStore
  baseUrl?: string
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<Server> {
  const port = options.port ?? 4097
  const store = options.store
  const baseUrl = options.baseUrl ?? "http://localhost:4096"
  const staticDir = resolve(__dirname, "../../dist/dashboard")

  // SSE clients per workflow
  const sseClients = new Map<string, Set<ServerResponse>>()

  const sendSse = (workflowId: string, data: unknown) => {
    const clients = sseClients.get(workflowId)
    if (!clients) return
    const payload = `data: ${JSON.stringify(data)}\n\n`
    for (const res of clients) {
      res.write(payload)
    }
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
    const pathname = url.pathname

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    // API: Health / server status
    if (pathname === "/api/health") {
      try {
        const { host, port: ocPort } = parseHostPort(baseUrl)
        const reachable = await checkPortOpen(host, ocPort, 2_000)
        const status = getServerStatus()
        // Derive stage from live TCP check when cached status is stale/idle
        let stage = status.stage
        let message = status.message
        if (reachable && (stage === "idle" || stage === "failed")) {
          stage = "ready"
          message = `OpenCode server connected at ${baseUrl}`
        }
        if (!reachable && stage === "ready") {
          stage = "failed"
          message = `OpenCode server at ${baseUrl} was reachable but is now down`
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          connected: reachable,
          baseUrl,
          stage,
          message,
          elapsedMs: status.elapsedMs,
          error: status.error,
        }))
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: String(e) }))
      }
      return
    }

    // API: List workflows
    if (pathname === "/api/workflows") {
      try {
        const states = await store.list()
        const summaries = states.map((s) => ({
          id: s.id,
          status: s.status,
          objective: s.objective,
          updatedAt: s.updatedAt,
          totalTokensUsed: s.totalTokensUsed,
        }))
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(summaries))
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: String(e) }))
      }
      return
    }

    // API: Get workflow state + events
    const workflowMatch = pathname.match(/^\/api\/workflow\/([^/]+)$/)
    if (workflowMatch && req.method === "GET") {
      const workflowId = decodeURIComponent(workflowMatch[1])
      try {
        const state = await store.load(workflowId)
        let events: Array<{ time: string; type: string; message: string }> = []
        try {
          const eventsPath = store.eventsPath(workflowId)
          const raw = await readFile(eventsPath, "utf8")
          events = raw
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              try {
                const ev = JSON.parse(line)
                return { time: ev.time ?? "", type: ev.type ?? "", message: ev.message ?? "" }
              } catch {
                return { time: "", type: "", message: "" }
              }
            })
            .filter((ev) => ev.type)
        } catch {
          // No events file
        }
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ state, events }))
      } catch (e) {
        res.writeHead(404, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Workflow not found" }))
      }
      return
    }

    // API: Workflow events SSE
    const eventsMatch = pathname.match(/^\/api\/workflow\/([^/]+)\/events$/)
    if (eventsMatch && req.method === "GET") {
      const workflowId = decodeURIComponent(eventsMatch[1])
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      res.write(":ok\n\n")
      const clients = sseClients.get(workflowId) ?? new Set()
      clients.add(res)
      sseClients.set(workflowId, clients)
      req.on("close", () => {
        clients.delete(res)
        if (clients.size === 0) sseClients.delete(workflowId)
      })
      return
    }

    // API: Approve workflow
    const approveMatch = pathname.match(/^\/api\/workflow\/([^/]+)\/approve$/)
    if (approveMatch && req.method === "POST") {
      const workflowId = decodeURIComponent(approveMatch[1])
      try {
        const { approveWorkflow } = await import("./approval.js")
        const updated = await approveWorkflow(workflowId, store)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: updated.status }))
        sendSse(workflowId, { type: "update" })
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: String(e) }))
      }
      return
    }

    // API: Reject workflow
    const rejectMatch = pathname.match(/^\/api\/workflow\/([^/]+)\/reject$/)
    if (rejectMatch && req.method === "POST") {
      const workflowId = decodeURIComponent(rejectMatch[1])
      try {
        const { rejectWorkflow } = await import("./approval.js")
        const updated = await rejectWorkflow(workflowId, store)
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ status: updated.status }))
        sendSse(workflowId, { type: "update" })
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: String(e) }))
      }
      return
    }

    // Static files
    let filePath = join(staticDir, pathname === "/" ? "index.html" : pathname)
    // SPA fallback: serve index.html for non-API routes
    if (!pathname.startsWith("/api/")) {
      try {
        const s = await stat(filePath)
        if (!s.isFile()) {
          filePath = join(staticDir, "index.html")
        }
      } catch {
        filePath = join(staticDir, "index.html")
      }
    }

    try {
      const content = await readFile(filePath)
      const ext = extname(filePath)
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" })
      res.end(content)
    } catch {
      res.writeHead(404)
      res.end("Not found")
    }
  })

  await new Promise<void>((resolve) => server.listen(port, () => resolve()))
  return server
}
