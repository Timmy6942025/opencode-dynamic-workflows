import { connect } from "node:net"

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function checkPortOpen(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, host)
    let done = false
    const finish = (open: boolean) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve(open)
    }
    socket.on("connect", () => finish(true))
    socket.on("error", () => finish(false))
    socket.on("timeout", () => finish(false))
    socket.setTimeout(timeoutMs)
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
