import { useState, useEffect, useCallback } from 'react'
import { cn, formatTokens, formatDuration, statusColor, statusTextColor } from './lib/utils'

interface WorkflowState {
  id: string
  objective: string
  status: string
  createdAt: string
  updatedAt: string
  totalTokensUsed: number
  plan?: { title: string; summary: string; phases: any[] }
  phases: Record<string, any>
  tasks: Record<string, any>
  error?: string
  summaryPath?: string
}

interface DashboardEvent {
  time: string
  type: string
  message: string
}

interface WorkflowSummary {
  id: string
  status: string
  objective: string
  updatedAt: string
  totalTokensUsed: number
}

function useWorkflowData() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowState | null>(null)
  const [events, setEvents] = useState<DashboardEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const workflowId = new URLSearchParams(window.location.search).get('id')

  const fetchWorkflows = useCallback(async () => {
    try {
      const res = await fetch('./api/workflows')
      if (!res.ok) throw new Error('Failed to fetch workflows')
      const data = await res.json()
      setWorkflows(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const fetchWorkflow = useCallback(async (id: string) => {
    try {
      const res = await fetch(`./api/workflow/${id}`)
      if (!res.ok) throw new Error('Failed to fetch workflow')
      const data = await res.json()
      setSelectedWorkflow(data.state)
      setEvents(data.events || [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    fetchWorkflows()
    if (workflowId) fetchWorkflow(workflowId)
    setLoading(false)
  }, [fetchWorkflows, fetchWorkflow, workflowId])

  // SSE for real-time updates
  useEffect(() => {
    if (!workflowId) return
    const es = new EventSource(`./api/workflow/${workflowId}/events`)
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data)
        if (data.type === 'update') {
          fetchWorkflow(workflowId)
        } else if (data.type === 'event') {
          setEvents((prev) => [...prev, data.payload])
        }
      } catch {
        // ignore parse errors
      }
    }
    es.onerror = () => {
      // Auto-reconnect handled by browser
    }
    return () => es.close()
  }, [workflowId, fetchWorkflow])

  return { workflows, selectedWorkflow, events, error, loading, fetchWorkflow, fetchWorkflows }
}

export default function App() {
  const { workflows, selectedWorkflow, events, error, loading, fetchWorkflow } = useWorkflowData()
  const [activeTab, setActiveTab] = useState<'overview' | 'tasks' | 'events' | 'artifacts'>('overview')

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading dashboard...</p>
        </div>
      </div>
    )
  }

  if (error && !selectedWorkflow) {
    return (
      <div className="flex h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md rounded-lg border border-destructive/20 bg-destructive/10 p-6 text-center">
          <h2 className="mb-2 text-lg font-semibold text-destructive">Dashboard Error</h2>
          <p className="text-sm text-destructive/80">{error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="w-72 border-r border-border bg-card flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-bold tracking-tight">oc-dw</h1>
          <p className="text-xs text-muted-foreground">Dynamic Workflows</p>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {workflows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No workflows found</p>
          ) : (
            workflows.map((wf) => (
              <button
                key={wf.id}
                onClick={() => {
                  const url = new URL(window.location.href)
                  url.searchParams.set('id', wf.id)
                  window.history.pushState({}, '', url)
                  fetchWorkflow(wf.id)
                }}
                className={cn(
                  'w-full text-left rounded-md px-3 py-2.5 text-sm transition-colors',
                  selectedWorkflow?.id === wf.id
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                )}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium truncate">{wf.objective.slice(0, 40)}</span>
                  <span className={cn('ml-2 h-2 w-2 rounded-full flex-shrink-0', statusColor(wf.status))} />
                </div>
                <div className="flex items-center justify-between text-xs opacity-70">
                  <span>{wf.id.slice(0, 8)}...</span>
                  <span>{formatTokens(wf.totalTokensUsed)} tok</span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {selectedWorkflow ? (
          <>
            {/* Header */}
            <header className="border-b border-border px-6 py-4">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <h2 className="text-xl font-semibold truncate">{selectedWorkflow.objective}</h2>
                  <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                    <span className={cn('font-medium', statusTextColor(selectedWorkflow.status))}>
                      {selectedWorkflow.status}
                    </span>
                    <span>•</span>
                    <span>{selectedWorkflow.id}</span>
                    <span>•</span>
                    <span>{formatTokens(selectedWorkflow.totalTokensUsed)} tokens</span>
                  </div>
                </div>
                {selectedWorkflow.status === 'plan_approval' && (
                  <div className="flex gap-2 flex-shrink-0">
                    <button
                      onClick={async () => {
                        await fetch(`./api/workflow/${selectedWorkflow.id}/approve`, { method: 'POST' })
                        fetchWorkflow(selectedWorkflow.id)
                      }}
                      className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
                    >
                      Approve
                    </button>
                    <button
                      onClick={async () => {
                        await fetch(`./api/workflow/${selectedWorkflow.id}/reject`, { method: 'POST' })
                        fetchWorkflow(selectedWorkflow.id)
                      }}
                      className="px-4 py-2 rounded-md bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
              {selectedWorkflow.error && (
                <div className="mt-3 rounded-md bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-800">
                  {selectedWorkflow.error}
                </div>
              )}
            </header>

            {/* Tabs */}
            <div className="border-b border-border px-6">
              <div className="flex gap-1">
                {(['overview', 'tasks', 'events', 'artifacts'] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={cn(
                      'px-4 py-2.5 text-sm font-medium capitalize border-b-2 transition-colors',
                      activeTab === tab
                        ? 'border-primary text-primary'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {activeTab === 'overview' && <OverviewTab workflow={selectedWorkflow} />}
              {activeTab === 'tasks' && <TasksTab workflow={selectedWorkflow} />}
              {activeTab === 'events' && <EventsTab events={events} />}
              {activeTab === 'artifacts' && <ArtifactsTab workflow={selectedWorkflow} />}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <p className="text-lg font-medium mb-1">Select a workflow</p>
              <p className="text-sm">Choose a workflow from the sidebar to view details</p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function OverviewTab({ workflow }: { workflow: WorkflowState }) {
  const taskStates = Object.values(workflow.tasks)
  const completed = taskStates.filter((t) => t.status === 'completed').length
  const failed = taskStates.filter((t) => t.status === 'failed').length
  const running = taskStates.filter((t) => t.status === 'running').length
  const pending = taskStates.filter((t) => t.status === 'pending').length
  const total = taskStates.length

  const phaseStates = Object.values(workflow.phases)
  const phasesCompleted = phaseStates.filter((p) => p.status === 'completed').length

  return (
    <div className="space-y-6">
      {/* Progress cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Tasks" value={`${completed}/${total}`} sub={`${failed} failed`} color={failed > 0 ? 'text-red-600' : 'text-emerald-600'} />
        <StatCard label="Phases" value={`${phasesCompleted}/${phaseStates.length}`} sub="completed" />
        <StatCard label="Tokens" value={formatTokens(workflow.totalTokensUsed)} sub="total used" />
        <StatCard label="Duration" value={formatDuration(workflow.createdAt, workflow.updatedAt)} sub="elapsed" />
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Progress</span>
            <span className="text-sm text-muted-foreground">{Math.round((completed / total) * 100)}%</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${(completed / total) * 100}%` }}
            />
          </div>
          <div className="flex gap-4 mt-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Completed</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500" /> Running</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-300" /> Pending</span>
            <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> Failed</span>
          </div>
        </div>
      )}

      {/* Phase DAG */}
      {workflow.plan && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-4">Phase Pipeline</h3>
          <div className="flex flex-wrap gap-3">
            {workflow.plan.phases.map((phase, idx) => {
              const phaseState = workflow.phases[phase.id]
              return (
                <div key={phase.id} className="flex items-center gap-3">
                  <div className={cn(
                    'rounded-lg border px-4 py-3 min-w-[180px]',
                    phaseState?.status === 'completed' ? 'border-emerald-200 bg-emerald-50' :
                    phaseState?.status === 'running' ? 'border-blue-200 bg-blue-50' :
                    phaseState?.status === 'failed' ? 'border-red-200 bg-red-50' :
                    'border-border bg-background'
                  )}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={cn('h-2.5 w-2.5 rounded-full', statusColor(phaseState?.status))} />
                      <span className="text-sm font-medium">{phase.title}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {phase.tasks.length} tasks
                      {phase.dependsOn.length > 0 && ` • depends on ${phase.dependsOn.join(', ')}`}
                    </div>
                  </div>
                  {idx < workflow.plan.phases.length - 1 && (
                    <span className="text-muted-foreground">→</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Plan summary */}
      {workflow.plan && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-2">Plan Summary</h3>
          <p className="text-sm text-muted-foreground">{workflow.plan.summary}</p>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={cn('text-2xl font-bold mt-1', color)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>
    </div>
  )
}

function TasksTab({ workflow }: { workflow: WorkflowState }) {
  const tasks = Object.values(workflow.tasks)
  if (tasks.length === 0) {
    return <p className="text-sm text-muted-foreground">No tasks yet</p>
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Task</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Phase</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Verified</th>
            <th className="text-left px-4 py-3 font-medium text-muted-foreground">Attempts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {tasks.map((task) => (
            <tr key={task.taskId} className="hover:bg-muted/30 transition-colors">
              <td className="px-4 py-3">
                <span className="font-medium">{task.taskId}</span>
                {task.error && <p className="text-xs text-red-600 mt-0.5">{task.error}</p>}
              </td>
              <td className="px-4 py-3 text-muted-foreground">{task.phaseId}</td>
              <td className="px-4 py-3">
                <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', statusBg(task.status))}>
                  <span className={cn('h-1.5 w-1.5 rounded-full', statusColor(task.status))} />
                  {task.status}
                </span>
              </td>
              <td className="px-4 py-3">
                {task.verified ? (
                  <span className="text-emerald-600 text-xs font-medium">Yes</span>
                ) : (
                  <span className="text-slate-400 text-xs">No</span>
                )}
              </td>
              <td className="px-4 py-3 text-muted-foreground">{task.attempts.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EventsTab({ events }: { events: DashboardEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet</p>
  }

  const reversed = [...events].reverse()

  return (
    <div className="space-y-1">
      {reversed.map((ev, i) => (
        <div key={i} className="flex items-start gap-3 rounded-md px-3 py-2.5 hover:bg-muted/30 transition-colors">
          <span className="text-xs text-muted-foreground font-mono flex-shrink-0 w-[140px]">
            {new Date(ev.time).toLocaleTimeString()}
          </span>
          <span className={cn('text-xs font-medium flex-shrink-0 w-[140px]', eventTypeColor(ev.type))}>
            {ev.type}
          </span>
          <span className="text-sm">{ev.message}</span>
        </div>
      ))}
    </div>
  )
}

function ArtifactsTab({ workflow }: { workflow: WorkflowState }) {
  const artifacts: { name: string; path?: string }[] = []
  if (workflow.summaryPath) artifacts.push({ name: 'Summary', path: workflow.summaryPath })
  if (workflow.plan) {
    artifacts.push({ name: 'Plan JSON' })
    if (workflow.plan.orchestrationScript) artifacts.push({ name: 'Orchestration Script' })
  }

  if (artifacts.length === 0) {
    return <p className="text-sm text-muted-foreground">No artifacts available</p>
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {artifacts.map((artifact) => (
        <div key={artifact.name} className="rounded-lg border border-border bg-card p-4 hover:border-primary/50 transition-colors cursor-pointer">
          <h4 className="text-sm font-medium">{artifact.name}</h4>
          {artifact.path && <p className="text-xs text-muted-foreground mt-1 truncate">{artifact.path}</p>}
        </div>
      ))}
    </div>
  )
}

function statusBg(status: string): string {
  switch (status) {
    case 'completed': return 'bg-emerald-100 text-emerald-700'
    case 'running': return 'bg-blue-100 text-blue-700'
    case 'failed': return 'bg-red-100 text-red-700'
    case 'pending': return 'bg-slate-100 text-slate-700'
    default: return 'bg-slate-100 text-slate-700'
  }
}

function eventTypeColor(type: string): string {
  if (type.includes('failed')) return 'text-red-600'
  if (type.includes('completed')) return 'text-emerald-600'
  if (type.includes('started')) return 'text-blue-600'
  if (type.includes('approved')) return 'text-purple-600'
  return 'text-muted-foreground'
}
