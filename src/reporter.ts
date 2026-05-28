import type { Reporter } from "./types.js"

export class ConsoleReporter implements Reporter {
  constructor(private readonly json = false) {}

  info(message: string, details?: Record<string, unknown>): void {
    this.write("info", message, details)
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.write("warn", message, details)
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.write("error", message, details)
  }

  private write(level: string, message: string, details?: Record<string, unknown>): void {
    if (this.json) {
      process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, details })}\n`)
      return
    }
    const suffix = details ? ` ${JSON.stringify(details)}` : ""
    const line = `[${level}] ${message}${suffix}\n`
    if (level === "error") process.stderr.write(line)
    else process.stdout.write(line)
  }
}

export class SilentReporter implements Reporter {
  info(): void {}
  warn(): void {}
  error(): void {}
}
