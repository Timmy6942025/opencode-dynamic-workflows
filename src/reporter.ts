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

  progress(report: import("./types.js").ProgressReport): void {
    if (this.json) {
      process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: "progress", report })}\n`)
      return
    }
    const pct = report.totalTasks > 0 ? Math.round((report.completedTasks / report.totalTasks) * 100) : 0
    process.stdout.write(
      `[progress] ${report.completedTasks}/${report.totalTasks} tasks, ${pct}% complete | tokens: ${report.tokensUsed}\n`,
    )
    if (report.blockers.length) {
      process.stdout.write(`  blockers: ${report.blockers.join("; ")}\n`)
    }
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
