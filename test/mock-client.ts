import type { ClientPromptOptions, PromptResult, ShellResult, WorkflowClient } from "../src/types.js"

export class MockWorkflowClient implements WorkflowClient {
  sessions: string[] = []
  prompts: Array<{ sessionId: string; text: string; options?: ClientPromptOptions }> = []
  shells: string[] = []
  deleted: string[] = []
  aborted: string[] = []

  /** The script the mock planner will return. */
  scriptToReturn = `
log("info", "Starting mock workflow")
const [result] = await wait(spawn("Mock Worker", "Do the work", { role: "worker" }))
return result.text
`

  async createSession(title: string): Promise<string> {
    const id = `session-${this.sessions.length + 1}-${title.replace(/[^a-z0-9]+/gi, "-").slice(0, 24)}`
    this.sessions.push(id)
    return id
  }

  async prompt(sessionId: string, text: string, options?: ClientPromptOptions): Promise<PromptResult> {
    this.prompts.push({ sessionId, text, options })
    if (options?.noReply) return { text: "" }

    // Planner prompt — return a workflow script
    if (text.includes("workflow script generator") || text.includes("You are a workflow script generator")) {
      return {
        text: "planned",
        structured: {
          title: "Mock Workflow",
          summary: "A mock workflow for testing",
          maxAgentEstimate: 2,
          script: this.scriptToReturn,
        },
      }
    }

    // Synthesizer
    if (text.includes("Synthesize") || text.includes("synthesiz")) {
      return { text: "# Final Report\n\nAll mocked tasks completed and verified." }
    }

    // Verifier
    if (text.includes("independent verifier") || text.includes("judge the worker")) {
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

    // Default worker response
    return { text: `worker output for ${sessionId}` }
  }

  async promptAsync(sessionId: string, text: string, options?: ClientPromptOptions): Promise<void> {
    // Fire-and-forget: record the prompt but resolve immediately.
    this.prompts.push({ sessionId, text, options })
  }

  async messages(_sessionId: string): Promise<unknown> {
    // Return the last worker prompt response so pollForCompletion finds it.
    return [
      {
        role: "assistant",
        parts: [{ type: "text", text: `worker output for ${_sessionId}` }],
      },
    ]
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
