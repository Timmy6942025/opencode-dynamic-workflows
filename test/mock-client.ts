import type { ClientPromptOptions, PromptResult, ShellResult, WorkflowClient, WorkflowPlan } from "../src/types.js"

export class MockWorkflowClient implements WorkflowClient {
  sessions: string[] = []
  prompts: Array<{ sessionId: string; text: string; options?: ClientPromptOptions }> = []
  shells: string[] = []
  deleted: string[] = []
  aborted: string[] = []

  constructor(private readonly plan: WorkflowPlan) {}

  async health(): Promise<unknown> {
    return { healthy: true }
  }

  async providers(): Promise<unknown> {
    return {}
  }

  async createSession(title: string): Promise<string> {
    const id = `session-${this.sessions.length + 1}-${title.replace(/[^a-z0-9]+/gi, "-").slice(0, 24)}`
    this.sessions.push(id)
    return id
  }

  async initSession(): Promise<void> {}

  async prompt(sessionId: string, text: string, options?: ClientPromptOptions): Promise<PromptResult> {
    this.prompts.push({ sessionId, text, options })
    if (options?.noReply) return { text: "" }
    if (text.includes("You are planning an OpenCode dynamic workflow")) {
      return { text: "planned", structured: this.plan }
    }
    if (text.includes("independent verifier")) {
      return {
        text: "pass",
        structured: {
          pass: true,
          confidence: 0.91,
          issues: [],
          evidence: ["mock verification evidence"],
        },
      }
    }
    if (text.includes("final dynamic workflow report")) {
      return { text: "# Final Report\n\nAll mocked tasks completed and verified." }
    }
    if (text.includes("summarizing a chunk")) {
      return { text: "chunk summary" }
    }
    return { text: `worker output for ${sessionId}` }
  }

  async shell(_sessionId: string, command: string): Promise<ShellResult> {
    this.shells.push(command)
    return {
      command,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId)
  }

  async abortSession(sessionId: string): Promise<void> {
    this.aborted.push(sessionId)
  }

  async log(): Promise<void> {}
}
