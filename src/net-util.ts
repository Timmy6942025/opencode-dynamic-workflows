import { connect } from "node:net"

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function checkPortOpen(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (open: boolean) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(open)
    }

    const socket = connect(port, host)
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.once("timeout", () => finish(false))

    // Fallback timer in case socket events don't fire on some platforms
    setTimeout(() => finish(false), timeoutMs + 500)
  })
}

export function parseHostPort(baseUrl: string): { host: string; port: number } {
  let urlStr = baseUrl.trim()
  if (!urlStr.includes("://")) {
    urlStr = `http://${urlStr}`
  }
  try {
    const url = new URL(urlStr)
    return { host: url.hostname, port: Number(url.port) || 4096 }
  } catch {
    return { host: "127.0.0.1", port: 4096 }
  }
}
