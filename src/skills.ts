import type { AgentTask, DynamicWorkflowOptions } from "./types.js"

export interface Skill {
  id: string
  name: string
  description: string
  constraints: string[]
  promptPrefix: string
  promptSuffix: string
  appliesTo: ModelRole[]
}

type ModelRole = "planner" | "worker" | "verifier" | "synthesizer" | "critic" | "scout" | "adversary"

const BUILT_IN_SKILLS: Skill[] = [
  {
    id: "no-casts",
    name: "No Type Casts",
    description: "Prohibit any type assertions or casts. All types must be inferred or explicitly declared.",
    constraints: ["No `as` type assertions", "No `any` casts", "No non-null assertions `!`"],
    promptPrefix: "",
    promptSuffix: "\n\nCRITICAL CONSTRAINT: Do not use any type casts, assertions, or `any`. All types must be properly inferred or explicitly declared.",
    appliesTo: ["worker", "planner"],
  },
  {
    id: "test-driven",
    name: "Test Driven",
    description: "All code changes must include corresponding tests. Write tests first when possible.",
    constraints: ["Write tests before or with implementation", "Cover edge cases", "All tests must pass"],
    promptPrefix: "",
    promptSuffix: "\n\nCRITICAL CONSTRAINT: Follow test-driven development. Write tests for every change. All tests must pass before finishing.",
    appliesTo: ["worker", "planner"],
  },
  {
    id: "minimal-diff",
    name: "Minimal Diff",
    description: "Make the smallest possible change. Do not refactor unrelated code. No formatting-only changes.",
    constraints: ["Smallest viable change", "No unrelated refactoring", "No whitespace/formatting-only changes"],
    promptPrefix: "",
    promptSuffix: "\n\nCRITICAL CONSTRAINT: Make the absolute minimal change necessary. Do not refactor unrelated code, change formatting, or touch files not directly involved.",
    appliesTo: ["worker"],
  },
  {
    id: "strict-types",
    name: "Strict Types",
    description: "All TypeScript code must pass strict mode. No implicit any. Explicit return types on exports.",
    constraints: ["No implicit any", "Explicit return types", "Strict null checks respected"],
    promptPrefix: "",
    promptSuffix: "\n\nCRITICAL CONSTRAINT: TypeScript strict mode compliance required. No implicit any. All exported functions must have explicit return types. Respect strict null checks.",
    appliesTo: ["worker", "critic", "synthesizer"],
  },
  {
    id: "security-first",
    name: "Security First",
    description: "All changes must be evaluated for security implications. No secrets in code. Input validation required.",
    constraints: ["No hardcoded secrets", "Validate all inputs", "Escape outputs", "Check for injection risks"],
    promptPrefix: "",
    promptSuffix: "\n\nCRITICAL CONSTRAINT: Security-first approach. Never hardcode secrets. Validate and sanitize all inputs. Escape outputs. Check for injection, XSS, and path traversal risks.",
    appliesTo: ["worker", "verifier", "critic"],
  },
  {
    id: "performance-aware",
    name: "Performance Aware",
    description: "Consider algorithmic complexity, memory usage, and I/O efficiency in all changes.",
    constraints: ["Consider Big-O complexity", "Avoid unnecessary allocations", "Minimize I/O where possible"],
    promptPrefix: "",
    promptSuffix: "\n\nCRITICAL CONSTRAINT: Performance-aware implementation. Consider algorithmic complexity. Avoid unnecessary memory allocations. Minimize blocking I/O.",
    appliesTo: ["worker", "planner"],
  },
  {
    id: "docs-required",
    name: "Documentation Required",
    description: "All public APIs and significant changes must include documentation.",
    constraints: ["Document public APIs", "Update README if behavior changes", "Inline comments for complex logic"],
    promptPrefix: "",
    promptSuffix: "\n\nCRITICAL CONSTRAINT: Document all public APIs. Update relevant documentation. Add inline comments for non-obvious logic.",
    appliesTo: ["worker", "synthesizer"],
  },
  {
    id: "backward-compat",
    name: "Backward Compatible",
    description: "Changes must not break existing APIs or behavior unless explicitly allowed.",
    constraints: ["No breaking API changes", "Deprecate before removing", "Migration path if breaking"],
    promptPrefix: "",
    promptSuffix: "\n\nCRITICAL CONSTRAINT: Maintain backward compatibility. Do not break existing APIs. If a breaking change is necessary, provide a migration path.",
    appliesTo: ["worker", "planner"],
  },
]

export function resolveSkills(skillIds: string[]): Skill[] {
  return skillIds
    .map((id) => BUILT_IN_SKILLS.find((s) => s.id === id))
    .filter((s): s is Skill => Boolean(s))
}

export function listSkills(): Array<{ id: string; name: string; description: string }> {
  return BUILT_IN_SKILLS.map((s) => ({ id: s.id, name: s.name, description: s.description }))
}

export function applySkillsToTask(task: AgentTask, skills: Skill[], role: ModelRole): AgentTask {
  const applicable = skills.filter((s) => s.appliesTo.includes(role))
  if (applicable.length === 0) return task

  const constraintLines = applicable.flatMap((s) => s.constraints.map((c) => `- ${c}`))
  const suffix = applicable.map((s) => s.promptSuffix).join("\n")

  return {
    ...task,
    prompt: `${task.prompt}\n\n--- Skills & Constraints ---\n${constraintLines.join("\n")}${suffix}`,
    acceptanceCriteria: [...task.acceptanceCriteria, ...constraintLines],
  }
}

export function applySkillsToOptions(options: DynamicWorkflowOptions): DynamicWorkflowOptions {
  const skills = resolveSkills(options.skills)
  if (skills.length === 0) return options

  const constraintLines = skills.flatMap((s) => s.constraints.map((c) => `- ${c}`))
  const enhancedObjective = `${options.objective}\n\n--- Global Constraints ---\n${constraintLines.join("\n")}`

  return {
    ...options,
    objective: enhancedObjective,
  }
}
