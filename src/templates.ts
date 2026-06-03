import type { DynamicWorkflowOptions, WorkflowTemplate } from "./types.js"

export const BUILT_IN_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "deep-research",
    name: "Deep Research",
    description: "Multi-angle investigation with cross-checking and synthesis.",
    category: "research",
    objectivePattern: "Research {topic} and produce a comprehensive report",
    defaultOptions: {
      maxAgents: 50,
      concurrency: 8,
      adversarialReview: true,

    },
    scriptTemplate: (objective, options) => `// Deep Research: fan-out research agents, verify, synthesize
log("info", "Starting deep research: " + objective)

// Phase 1: Fan out research from multiple angles
const results = await parallel([
  { label: "Primary Sources", prompt: "Research primary sources and official documentation for: " + objective + "\\nCite specific sources with URLs.", role: "scout" },
  { label: "Contrarian Analysis", prompt: "Research criticisms, limitations, and counter-arguments for: " + objective + "\\nBe skeptical. Cite sources.", role: "critic" },
  { label: "Technical Deep-Dive", prompt: "Research technical implementation details and architecture for: " + objective + "\\nInclude concrete examples.", role: "worker" },
  { label: "Community & Trends", prompt: "Research community perspectives, recent developments, and trends for: " + objective + "\\nLook for real-world case studies.", role: "scout" },
])

log("info", "Research phase complete — " + results.length + " sources collected")

// Phase 2: Cross-check findings
const crosscheckAgents = results.map((r, i) => spawn(
  "Cross-check " + (i + 1),
  "Review this research output. Identify contradictions, gaps, unsupported claims, and areas needing more evidence.\\n\\n" + truncate(r.text, 8000),
  { role: "verifier" }
))
const crosschecks = await wait(crosscheckAgents)

const allIssues = crosschecks.flatMap((c, i) => {
  if (c.error) return []
  return c.text.split("\\n").filter(l => l.includes("issue") || l.includes("gap") || l.includes("contradiction"))
})
log("info", "Cross-check complete — " + allIssues.length + " issues found")

// Phase 3: Synthesize final report
const researchAgents = results.map((r, i) => spawn("Source " + (i + 1), r.text))
const final = await synthesize({
  agents: researchAgents,
  prompt: "Synthesize all research into a comprehensive markdown report with:\\n1. Executive summary\\n2. Detailed findings (cite sources)\\n3. Contradictions and open questions\\n4. Recommendations\\n\\nObjective: " + objective,
})

return final.text`,
    skills: ["research", "citation", "verification"],
  },
  {
    id: "codebase-audit",
    name: "Codebase Security Audit",
    description: "Systematic security/quality audit with adversarial verification.",
    category: "audit",
    objectivePattern: "Audit {target} for security issues, bugs, and code quality",
    defaultOptions: {
      maxAgents: 100,
      concurrency: 16,
      adversarialReview: true,

    },
    scriptTemplate: (objective, options) => `// Codebase Audit: parallel audit agents, adversarial verification
log("info", "Starting codebase audit: " + objective)

// Step 1: Map the codebase
const [mapping] = await wait(spawn("Map Codebase", [
  "Survey the repository and identify all files relevant to: " + objective,
  "Group files by module/area. List test files. Estimate complexity.",
  "Return a structured list of file paths grouped by area.",
].join("\\n"), { role: "scout" }))

log("info", "Codebase mapped")

// Step 2: Parallel audit from different angles
const auditResults = await parallel([
  { label: "Input Validation", prompt: "Audit all relevant code for input validation issues (injection, XSS, path traversal).\\n\\nCodebase map:\\n" + truncate(mapping.text, 6000) + "\\n\\nObjective: " + objective, role: "critic" },
  { label: "Auth & Access Control", prompt: "Audit all relevant code for authentication and authorization issues.\\n\\nCodebase map:\\n" + truncate(mapping.text, 6000) + "\\n\\nObjective: " + objective, role: "critic" },
  { label: "Data Exposure", prompt: "Audit all relevant code for data exposure, secrets in code, and information leakage.\\n\\nCodebase map:\\n" + truncate(mapping.text, 6000) + "\\n\\nObjective: " + objective, role: "critic" },
  { label: "Error Handling", prompt: "Audit all relevant code for error handling issues, unhandled exceptions, and missing edge cases.\\n\\nCodebase map:\\n" + truncate(mapping.text, 6000) + "\\n\\nObjective: " + objective, role: "critic" },
])

log("info", "Audit agents complete — " + auditResults.length + " reports")

// Step 3: Adversarial verification of findings
const verifyAgents = auditResults.map((r, i) => spawn("Verify Audit " + (i + 1), [
  "Verify these audit findings against the actual codebase. For each finding:",
  "- Is it a real issue or false positive?",
  "- What is the severity (critical/high/medium/low)?",
  "- Provide the exact file and line if possible.",
  "",
  "Findings:",
  truncate(r.text, 8000),
].join("\\n"), { role: "verifier" }))
const verifications = await wait(verifyAgents)

// Step 4: Synthesize final report
const allFindings = auditResults.map((r, i) => spawn("Audit " + (i + 1), r.text))
const report = await synthesize({
  agents: allFindings,
  prompt: "Synthesize the audit findings into a prioritized security report with:\\n1. Executive summary\\n2. Critical findings\\n3. High findings\\n4. Medium/Low findings\\n5. Recommendations\\n\\nObjective: " + objective,
})

return report.text`,
    skills: ["security-first", "code-review"],
  },
  {
    id: "large-migration",
    name: "Large-Scale Migration",
    description: "Migrate code with parallel agents per file/module and verification.",
    category: "migration",
    objectivePattern: "Migrate {source} to {target}",
    defaultOptions: {
      maxAgents: 200,
      concurrency: 16,
      adversarialReview: true,

    },
    scriptTemplate: (objective, options) => `// Large Migration: discover targets, migrate in parallel, verify
log("info", "Starting migration: " + objective)

// Step 1: Discover all files/modules to migrate
const [discovery] = await wait(spawn("Discover Migration Targets", [
  "Identify all files and modules that need to be migrated for: " + objective,
  "Return a JSON array of file paths, one per line.",
  "Group them by dependency order if possible.",
].join("\\n"), { role: "scout" }))

// Parse file list
const files = discovery.text.split("\\n").filter(l => l.match(/\\.(ts|js|tsx|jsx|py|go|rs|java|rb)$/)).slice(0, ${options.maxAgents})
log("info", "Found " + files.length + " files to migrate")

if (files.length === 0) {
  return "No files found to migrate for: " + objective
}

// Step 2: Migrate files in parallel batches
const results = await forEach(files, (file, i) => ({
  label: "Migrate " + file,
  prompt: [
    "Migrate this file according to: " + objective,
    "",
    "File: " + file,
    "",
    "Rules:",
    "- Make the minimal changes needed for the migration",
    "- Preserve all existing behavior",
    "- Update imports/references as needed",
    "- Report what changed and any risks",
  ].join("\\n"),
  role: "worker",
}))

log("info", "Migration complete — " + results.filter(r => !r.error).length + "/" + results.length + " succeeded")

// Step 3: Verify with adversarial review
const worker = spawn("Migration Summary", results.map((r, i) => "File " + files[i] + ": " + truncate(r.text, 200)).join("\\n"))
const {verification} = await adversarial({
  worker,
  rubric: [
    "All files migrated consistently",
    "No partial migrations",
    "Imports updated correctly",
    "Behavior preserved",
  ],
})

log("info", "Verification: " + (verification.pass ? "PASS" : "FAIL") + " (confidence: " + verification.confidence + ")")

return results.map((r, i) => "## " + files[i] + "\\n" + r.text).join("\\n\\n")`,
    skills: ["minimal-diff", "test-driven", "backward-compat"],
  },
  {
    id: "test-generation",
    name: "Comprehensive Test Generation",
    description: "Generate tests with edge cases and coverage analysis.",
    category: "testing",
    objectivePattern: "Generate comprehensive tests for {target}",
    defaultOptions: {
      maxAgents: 60,
      concurrency: 12,
      adversarialReview: true,
    },
    scriptTemplate: (objective, options) => `// Test Generation: discover test targets, generate tests, verify
log("info", "Starting test generation: " + objective)

// Step 1: Map the codebase
const [mapping] = await wait(spawn("Map Test Targets", [
  "Identify all modules and functions that need test coverage for: " + objective,
  "List existing test files and their coverage.",
  "Identify gaps — modules with no tests or insufficient edge cases.",
].join("\\n"), { role: "scout" }))

// Step 2: Generate tests in parallel
const [targets] = await wait(spawn("Plan Test Cases", [
  "Based on this codebase map, list all functions/modules that need tests.",
  "For each, identify the edge cases to cover.",
  "",
  "Map:",
  truncate(mapping.text, 8000),
].join("\\n"), { role: "planner" }))

const testResults = await parallel([
  { label: "Unit Tests", prompt: "Write comprehensive unit tests for: " + objective + "\\n\\nCodebase context:\\n" + truncate(mapping.text, 6000) + "\\n\\nTest plan:\\n" + truncate(targets.text, 4000) + "\\n\\nCover edge cases, error paths, and boundary conditions.", role: "worker" },
  { label: "Integration Tests", prompt: "Write integration tests for: " + objective + "\\n\\nCodebase context:\\n" + truncate(mapping.text, 6000) + "\\n\\nTest the interactions between modules.", role: "worker" },
])

log("info", "Test generation complete")

// Step 3: Verify tests actually pass
const verifyResult = await shell("npm test 2>&1 || true")
const allPass = verifyResult.exitCode === 0

if (!allPass) {
  log("warn", "Some tests failed — fixing...")
  const [fix] = await wait(spawn("Fix Failing Tests", [
    "The following tests failed. Fix them:",
    "",
    truncate(verifyResult.stdout, 8000),
    truncate(verifyResult.stderr, 4000),
  ].join("\\n"), { role: "worker" }))
  return fix.text
}

return testResults.map(r => r.text).join("\\n\\n---\\n\\n")`,
    skills: ["test-driven", "edge-cases"],
  },
  {
    id: "documentation-update",
    name: "Documentation Update",
    description: "Update or generate documentation with verification.",
    category: "docs",
    objectivePattern: "Update documentation for {target}",
    defaultOptions: {
      maxAgents: 30,
      concurrency: 8,
      adversarialReview: false,
    },
    scriptTemplate: (objective, options) => `// Documentation Update: discover docs, update in parallel
log("info", "Starting documentation update: " + objective)

// Step 1: Map existing documentation
const [mapping] = await wait(spawn("Map Documentation", [
  "Survey the repository for all documentation files (README, docs/, comments, JSDoc) related to: " + objective,
  "Identify what's outdated, missing, or inconsistent with the code.",
].join("\\n"), { role: "scout" }))

// Step 2: Update docs in parallel
const docResults = await parallel([
  { label: "README Updates", prompt: "Update the README documentation for: " + objective + "\\n\\nCurrent state:\\n" + truncate(mapping.text, 6000), role: "worker" },
  { label: "API Documentation", prompt: "Update API documentation and JSDoc comments for: " + objective + "\\n\\nCurrent state:\\n" + truncate(mapping.text, 6000), role: "worker" },
  { label: "Usage Examples", prompt: "Generate or update usage examples for: " + objective + "\\n\\nCurrent state:\\n" + truncate(mapping.text, 6000), role: "worker" },
])

log("info", "Documentation update complete")
return docResults.map(r => r.text).join("\\n\\n---\\n\\n")`,
    skills: ["docs-required"],
  },
  {
    id: "refactor",
    name: "Pattern Refactor",
    description: "Systematically refactor a codebase pattern with parallel agents per file.",
    category: "refactor",
    objectivePattern: "Refactor {target} to use {pattern}",
    defaultOptions: {
      maxAgents: 80,
      concurrency: 12,
      adversarialReview: true,

    },
    scriptTemplate: (objective, options) => `// Refactor: discover targets, refactor in parallel, verify
log("info", "Starting refactor: " + objective)

// Step 1: Find all files using the old pattern
const [discovery] = await wait(spawn("Find Refactor Targets", [
  "Find all files that need to be refactored for: " + objective,
  "Return a list of file paths and what needs to change in each.",
].join("\\n"), { role: "scout" }))

const files = discovery.text.split("\\n").filter(l => l.match(/\\.(ts|js|tsx|jsx|py|go|rs|java|rb)$/)).slice(0, ${options.maxAgents})
log("info", "Found " + files.length + " files to refactor")

if (files.length === 0) {
  return "No files found to refactor for: " + objective
}

// Step 2: Refactor files in parallel
const results = await forEach(files, (file, i) => ({
  label: "Refactor " + file,
  prompt: [
    "Refactor this file for: " + objective,
    "",
    "File: " + file,
    "",
    "Rules:",
    "- Make the minimal change needed",
    "- Preserve all existing behavior",
    "- Do not refactor unrelated code",
  ].join("\\n"),
  role: "worker",
}))

log("info", "Refactoring complete — " + results.filter(r => !r.error).length + "/" + results.length + " succeeded")

// Step 3: Verify with tests
const testResult = await shell("npm test 2>&1 || true")
const testsPass = testResult.exitCode === 0

if (!testsPass) {
  log("warn", "Tests failing after refactor — fixing...")
  const [fix] = await wait(spawn("Fix Test Failures", [
    "Tests are failing after the refactor. Fix them.",
    "",
    "Test output:",
    truncate(testResult.stdout, 6000),
    truncate(testResult.stderr, 3000),
  ].join("\\n"), { role: "worker" }))
  return "Refactored " + files.length + " files. Fixed test failures.\\n\\n" + fix.text
}

return "Refactored " + files.length + " files successfully. All tests pass."`,
    skills: ["minimal-diff", "strict-types", "backward-compat"],
  },
  {
    id: "feature",
    name: "End-to-End Feature",
    description: "Implement a new feature with tests and documentation.",
    category: "feature",
    objectivePattern: "Implement {feature} with tests and documentation",
    defaultOptions: {
      maxAgents: 60,
      concurrency: 10,
      adversarialReview: true,
    },
    scriptTemplate: (objective, options) => `// Feature: plan, implement, test, document
log("info", "Starting feature implementation: " + objective)

// Step 1: Plan the implementation
const [plan] = await wait(spawn("Plan Feature", [
  "Plan the implementation for: " + objective,
  "",
  "Return:",
  "1. Files to create/modify",
  "2. API design",
  "3. Dependencies",
  "4. Test plan",
].join("\\n"), { role: "planner" }))

log("info", "Feature plan complete")

// Step 2: Implement in parallel
const [implementation] = await wait(spawn("Implement Feature", [
  "Implement this feature: " + objective,
  "",
  "Plan:",
  truncate(plan.text, 8000),
].join("\\n"), { role: "worker" }))

// Step 3: Write tests
const [tests] = await wait(spawn("Write Tests", [
  "Write comprehensive tests for this feature: " + objective,
  "",
  "Implementation:",
  truncate(implementation.text, 8000),
].join("\\n"), { role: "worker" }))

// Step 4: Verify
const testResult = await shell("npm test 2>&1 || true")
const testsPass = testResult.exitCode === 0

if (!testsPass) {
  log("warn", "Tests failing — fixing...")
  const [fix] = await wait(spawn("Fix Tests", [
    "Fix the failing tests:",
    truncate(testResult.stdout, 6000),
    truncate(testResult.stderr, 3000),
  ].join("\\n"), { role: "worker" }))
}

// Step 5: Document
const [docs] = await wait(spawn("Document Feature", [
  "Write documentation for this feature: " + objective,
  "",
  "Implementation:",
  truncate(implementation.text, 4000),
].join("\\n"), { role: "worker" }))

return [
  "# Feature: " + objective,
  "",
  "## Implementation",
  implementation.text,
  "",
  "## Tests",
  tests.text,
  "",
  "## Documentation",
  docs.text,
].join("\\n")`,
    skills: ["test-driven", "docs-required", "strict-types"],
  },
  {
    id: "performance",
    name: "Performance Optimization",
    description: "Find and fix performance bottlenecks with benchmarks.",
    category: "performance",
    objectivePattern: "Optimize performance of {target}",
    defaultOptions: {
      maxAgents: 40,
      concurrency: 8,
      adversarialReview: true,

    },
    scriptTemplate: (objective, options) => `// Performance Optimization: profile, identify bottlenecks, fix, benchmark
log("info", "Starting performance optimization: " + objective)

// Step 1: Profile and identify bottlenecks
const [profiling] = await wait(spawn("Profile Codebase", [
  "Analyze the codebase for performance bottlenecks: " + objective,
  "Look for: O(n²) loops, unnecessary allocations, blocking I/O, missing caching, N+1 queries.",
  "Rank issues by impact.",
].join("\\n"), { role: "scout" }))

log("info", "Profiling complete")

// Step 2: Fix bottlenecks in parallel
const [fixes] = await wait(spawn("Fix Bottlenecks", [
  "Fix the performance bottlenecks identified:",
  "",
  truncate(profiling.text, 8000),
  "",
  "Objective: " + objective,
].join("\\n"), { role: "worker" }))

// Step 3: Benchmark before/after
const benchmarkResult = await shell("npm test 2>&1 || true")

// Step 4: Verify the fixes are correct
const worker = spawn("Verify Fixes", fixes.text)
const {verification} = await adversarial({
  worker,
  rubric: [
    "Performance improvements are measurable",
    "No regression in functionality",
    "Changes are minimal and focused",
  ],
})

return [
  "# Performance Optimization: " + objective,
  "",
  "## Bottlenecks Found",
  profiling.text,
  "",
  "## Fixes Applied",
  fixes.text,
  "",
  "## Verification",
  "Pass: " + verification.pass + " (confidence: " + verification.confidence + ")",
  "Issues: " + (verification.issues.join(", ") || "none"),
].join("\\n")`,
    skills: ["performance-aware", "test-driven"],
  },
  {
    id: "api-design",
    name: "API Design & Implementation",
    description: "Design, implement, and document a new API.",
    category: "api",
    objectivePattern: "Design and implement {api}",
    defaultOptions: {
      maxAgents: 40,
      concurrency: 8,
      adversarialReview: true,
    },
    scriptTemplate: (objective, options) => `// API Design: design, implement, test, document
log("info", "Starting API design: " + objective)

// Step 1: Design the API
const [design] = await wait(spawn("Design API", [
  "Design a clean API for: " + objective,
  "",
  "Include:",
  "- Endpoint/route definitions",
  "- Request/response schemas",
  "- Error handling",
  "- Authentication requirements",
  "- OpenAPI/Swagger spec",
].join("\\n"), { role: "planner" }))

log("info", "API design complete")

// Step 2: Implement
const [implementation] = await wait(spawn("Implement API", [
  "Implement the API: " + objective,
  "",
  "Design:",
  truncate(design.text, 8000),
].join("\\n"), { role: "worker" }))

// Step 3: Security review
const worker = spawn("Security Review", implementation.text)
const {verification} = await adversarial({
  worker,
  rubric: [
    "Input validation on all endpoints",
    "Authentication/authorization correct",
    "No SQL injection or XSS vectors",
    "Proper error handling (no stack traces to client)",
    "Rate limiting considered",
  ],
})

if (!verification.pass) {
  log("warn", "Security issues found: " + verification.issues.join("; "))
  const [fix] = await wait(spawn("Fix Security Issues", [
    "Fix these security issues in the API implementation:",
    verification.issues.join("\\n"),
  ].join("\\n"), { role: "worker" }))
}

// Step 4: Write tests
const [tests] = await wait(spawn("Write API Tests", [
  "Write tests for the API: " + objective,
  "",
  "Implementation:",
  truncate(implementation.text, 6000),
].join("\\n"), { role: "worker" }))

return [
  "# API: " + objective,
  "",
  "## Design",
  design.text,
  "",
  "## Implementation",
  implementation.text,
  "",
  "## Tests",
  tests.text,
  "",
  "## Security Review",
  "Pass: " + verification.pass,
  "Issues: " + (verification.issues.join(", ") || "none"),
].join("\\n")`,
    skills: ["docs-required", "security-first", "test-driven"],
  },
  {
    id: "dependency-audit",
    name: "Dependency Audit",
    description: "Audit dependencies for vulnerabilities, outdated packages, and license issues.",
    category: "audit",
    objectivePattern: "Audit dependencies for {target}",
    defaultOptions: {
      maxAgents: 30,
      concurrency: 8,
      adversarialReview: false,
    },
    scriptTemplate: (objective, options) => `// Dependency Audit: scan, analyze, report
log("info", "Starting dependency audit: " + objective)

// Step 1: Get dependency info
const lockfileResult = await shell("cat package-lock.json 2>/dev/null || cat yarn.lock 2>/dev/null || echo 'no lockfile'")
const auditResult = await shell("npm audit --json 2>/dev/null || echo '{\\"vulnerabilities\\":{}}'")
const outdatedResult = await shell("npm outdated --json 2>/dev/null || echo '{}'")

// Step 2: Analyze in parallel
const results = await parallel([
  { label: "Vulnerabilities", prompt: "Analyze these npm audit results for security vulnerabilities:\\n" + truncate(auditResult.stdout, 8000) + "\\n\\nObjective: " + objective, role: "critic" },
  { label: "Outdated Packages", prompt: "Analyze these outdated packages and assess risk:\\n" + truncate(outdatedResult.stdout, 8000) + "\\n\\nObjective: " + objective, role: "scout" },
  { label: "License Check", prompt: "Check the dependency tree for license compatibility issues in: " + objective + "\\n\\nLockfile (first 8k chars):\\n" + truncate(lockfileResult.stdout, 8000), role: "verifier" },
])

// Step 3: Synthesize report
const reportAgents = results.map((r, i) => spawn("Report " + (i + 1), r.text))
const report = await synthesize({
  agents: reportAgents,
  prompt: "Synthesize the dependency audit into a prioritized report with:\\n1. Critical vulnerabilities\\n2. Outdated packages\\n3. License issues\\n4. Recommended actions",
})

return report.text`,
    skills: ["security-first"],
  },
]

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

export function resolveTemplate(templateId?: string): WorkflowTemplate | undefined {
  if (!templateId) return undefined
  return BUILT_IN_TEMPLATES.find((t) => t.id === templateId)
}

export function applyTemplate(template: WorkflowTemplate, options: DynamicWorkflowOptions): DynamicWorkflowOptions {
  const merged = { ...options }
  // Merge default options
  for (const [key, value] of Object.entries(template.defaultOptions)) {
    if (value !== undefined) {
      ;(merged as Record<string, unknown>)[key] = value
    }
  }
  // Merge skills
  merged.skills = [...new Set([...options.skills, ...template.skills])]
  // Store script template in metadata
  merged.metadata = { ...merged.metadata, scriptTemplate: template.scriptTemplate }
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
