import type { DynamicWorkflowOptions, WorkflowPlan, WorkflowTemplate } from "./types.js"

export const BUILT_IN_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "refactor",
    name: "Pattern Refactor",
    description: "Systematically refactor a codebase pattern (e.g., callbacks → async/await, var → const).",
    category: "refactor",
    objectivePattern: "Refactor {target} to use {pattern}",
    defaultOptions: {
      maxAgents: 80,
      concurrency: 12,
      verificationRounds: 1,
      adversarialReview: true,
      scoutFirst: true,
      skills: ["minimal-diff", "strict-types", "backward-compat"],
    },
    skills: ["minimal-diff", "strict-types", "backward-compat"],
  },
  {
    id: "feature",
    name: "End-to-End Feature",
    description: "Implement a new feature from design through implementation, tests, and documentation.",
    category: "feature",
    objectivePattern: "Implement {feature} with tests and documentation",
    defaultOptions: {
      maxAgents: 60,
      concurrency: 10,
      verificationRounds: 2,
      retryLimit: 2,
      adversarialReview: true,
      scoutFirst: true,
      skills: ["test-driven", "docs-required", "strict-types"],
    },
    skills: ["test-driven", "docs-required", "strict-types"],
  },
  {
    id: "api-design",
    name: "API Design & Implementation",
    description: "Design, implement, and document a new API or endpoint.",
    category: "api",
    objectivePattern: "Design and implement {api} with OpenAPI docs and tests",
    defaultOptions: {
      maxAgents: 40,
      concurrency: 8,
      verificationRounds: 2,
      adversarialReview: true,
      skills: ["docs-required", "security-first", "test-driven"],
    },
    skills: ["docs-required", "security-first", "test-driven"],
  },
  {
    id: "dependency-audit",
    name: "Dependency Audit",
    description: "Audit dependencies for vulnerabilities, outdated packages, and license issues.",
    category: "audit",
    objectivePattern: "Audit dependencies for {target} and produce actionable report",
    defaultOptions: {
      maxAgents: 30,
      concurrency: 8,
      verificationRounds: 1,
      adversarialReview: false,
      skills: ["security-first"],
    },
    skills: ["security-first"],
  },
  {
    id: "performance",
    name: "Performance Optimization",
    description: "Find and fix performance bottlenecks with before/after benchmarks.",
    category: "performance",
    objectivePattern: "Optimize performance of {target} with benchmarks",
    defaultOptions: {
      maxAgents: 40,
      concurrency: 8,
      verificationRounds: 1,
      adversarialReview: true,
      scoutFirst: true,
      skills: ["performance-aware", "test-driven"],
    },
    skills: ["performance-aware", "test-driven"],
  },
  {
    id: "deep-research",
    name: "Deep Research",
    description: "Investigate a topic across multiple angles, cross-check findings, and synthesize a comprehensive report.",
    category: "research",
    objectivePattern: "Research {topic} and produce a comprehensive report with sources and cross-checked findings",
    defaultOptions: {
      maxAgents: 50,
      concurrency: 8,
      verificationRounds: 2,
      adversarialReview: true,
      convergenceThreshold: 0.8,
      progressReportIntervalMs: 30_000,
    },
    planTemplate: {
      title: "Deep Research",
      summary: "Parallel research agents investigate from different angles, then adversarial reviewers cross-check before synthesis.",
      maxAgentEstimate: 50,
      phases: [
        {
          id: "research",
          title: "Parallel Research",
          description: "Multiple agents research the topic from different angles.",
          strategy: "Fan out 4-8 research agents with different search strategies.",
          dependsOn: [],
          qualityGates: [],
          verification: { strategy: "Check that research covers diverse sources and cites concrete evidence." },
          tasks: [
            {
              id: "research-primary",
              title: "Primary source research",
              prompt: "Research the primary sources, official documentation, and authoritative references for this topic. Cite specific sources.",
              role: "scout",
              targetFiles: [],
              acceptanceCriteria: ["Cites at least 3 specific sources", "Includes URLs or references"],
              expectedArtifacts: ["research notes"],
              canEdit: false,
              dependsOn: [],
            },
            {
              id: "research-contrarian",
              title: "Contrarian perspective research",
              prompt: "Research criticisms, limitations, counter-arguments, and edge cases for this topic. Be skeptical.",
              role: "critic",
              targetFiles: [],
              acceptanceCriteria: ["Identifies at least 2 significant limitations", "Cites sources for counter-arguments"],
              expectedArtifacts: ["contrarian analysis"],
              canEdit: false,
              dependsOn: [],
            },
            {
              id: "research-technical",
              title: "Technical deep-dive",
              prompt: "Research the technical implementation details, architecture, and underlying mechanisms. Include code examples where relevant.",
              role: "worker",
              targetFiles: [],
              acceptanceCriteria: ["Includes technical details", "Provides concrete examples"],
              expectedArtifacts: ["technical analysis"],
              canEdit: false,
              dependsOn: [],
            },
          ],
        },
        {
          id: "verify",
          title: "Cross-Check and Verify",
          description: "Verify findings against each other and identify gaps.",
          strategy: "Use adversarial reviewers to cross-check research findings.",
          dependsOn: ["research"],
          qualityGates: [],
          verification: { strategy: "Check for contradictions, gaps, and unsupported claims." },
          tasks: [
            {
              id: "verify-crosscheck",
              title: "Cross-check findings",
              prompt: "Review all research outputs. Identify contradictions, gaps, unsupported claims, and areas needing more evidence.",
              role: "verifier",
              targetFiles: [],
              acceptanceCriteria: ["Identifies all contradictions", "Names specific gaps"],
              expectedArtifacts: ["verification report"],
              canEdit: false,
              dependsOn: ["research-primary", "research-contrarian", "research-technical"],
            },
          ],
        },
        {
          id: "synthesize",
          title: "Synthesize Report",
          description: "Merge verified findings into a comprehensive report.",
          strategy: "Synthesizer merges all verified findings into final markdown report.",
          dependsOn: ["verify"],
          qualityGates: [],
          verification: { strategy: "Check that report is comprehensive, well-structured, and cites all sources." },
          tasks: [
            {
              id: "synthesize-report",
              title: "Synthesize final report",
              prompt: "Synthesize all verified research findings into a comprehensive markdown report with executive summary, detailed findings, and recommendations.",
              role: "synthesizer",
              targetFiles: [],
              acceptanceCriteria: ["Includes executive summary", "Cites all sources", "Well-structured markdown"],
              expectedArtifacts: ["final report"],
              canEdit: true,
              dependsOn: ["verify-crosscheck"],
            },
          ],
        },
      ],
      requiresApproval: true,
    },
    skills: ["research", "citation", "verification"],
  },
  {
    id: "codebase-audit",
    name: "Codebase Security Audit",
    description: "Systematically audit a codebase for security issues, bugs, and code quality problems.",
    category: "audit",
    objectivePattern: "Audit {target} for security issues, bugs, and code quality problems",
    defaultOptions: {
      maxAgents: 100,
      concurrency: 16,
      verificationRounds: 1,
      adversarialReview: true,
      failFast: false,
    },
    skills: ["security", "code-review", "static-analysis"],
  },
  {
    id: "large-migration",
    name: "Large-Scale Migration",
    description: "Migrate a codebase from one framework, language, or pattern to another with verification at each step.",
    category: "migration",
    objectivePattern: "Migrate {source} to {target} with parity verification",
    defaultOptions: {
      maxAgents: 200,
      concurrency: 16,
      verificationRounds: 2,
      retryLimit: 2,
      adversarialReview: true,
      progressReportIntervalMs: 120_000,
    },
    skills: ["migration", "testing", "parity-check"],
  },
  {
    id: "test-generation",
    name: "Comprehensive Test Generation",
    description: "Generate tests for a codebase with coverage analysis and edge case detection.",
    category: "testing",
    objectivePattern: "Generate comprehensive tests for {target} with edge case coverage",
    defaultOptions: {
      maxAgents: 60,
      concurrency: 12,
      verificationRounds: 1,
      adversarialReview: true,
      skills: ["testing", "edge-cases", "coverage"],
    },
    skills: ["testing", "edge-cases", "coverage"],
  },
  {
    id: "documentation-update",
    name: "Documentation Update",
    description: "Update or generate documentation for a codebase, API, or feature.",
    category: "docs",
    objectivePattern: "Update documentation for {target} to reflect current implementation",
    defaultOptions: {
      maxAgents: 30,
      concurrency: 8,
      verificationRounds: 1,
      adversarialReview: false,
    },
    skills: ["documentation", "technical-writing"],
  },
]

export function resolveTemplate(templateId?: string): WorkflowTemplate | undefined {
  if (!templateId) return undefined
  return BUILT_IN_TEMPLATES.find((t) => t.id === templateId)
}

export function applyTemplate(template: WorkflowTemplate, options: DynamicWorkflowOptions): DynamicWorkflowOptions {
  const merged: DynamicWorkflowOptions = {
    ...options,
    ...template.defaultOptions,
    skills: [...new Set([...options.skills, ...template.skills])],
  }
  if (template.planTemplate) {
    merged.metadata = { ...merged.metadata, planTemplate: template.planTemplate }
  }
  return merged
}

export function listTemplates(): Array<{ id: string; name: string; description: string; category: string }> {
  return BUILT_IN_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
  }))
}
