import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatDuration(start?: string, end?: string): string {
  if (!start) return '-'
  const s = new Date(start).getTime()
  const e = end ? new Date(end).getTime() : Date.now()
  const diff = Math.max(0, e - s)
  const mins = Math.floor(diff / 60000)
  const secs = Math.floor((diff % 60000) / 1000)
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

export function statusColor(status: string): string {
  switch (status) {
    case 'completed': return 'bg-emerald-500'
    case 'running': return 'bg-blue-500'
    case 'failed': return 'bg-red-500'
    case 'paused': return 'bg-amber-500'
    case 'planning': return 'bg-purple-500'
    case 'plan_approval': return 'bg-orange-500'
    case 'aborted': return 'bg-slate-500'
    default: return 'bg-slate-300'
  }
}

export function statusTextColor(status: string): string {
  switch (status) {
    case 'completed': return 'text-emerald-600'
    case 'running': return 'text-blue-600'
    case 'failed': return 'text-red-600'
    case 'paused': return 'text-amber-600'
    case 'planning': return 'text-purple-600'
    case 'plan_approval': return 'text-orange-600'
    case 'aborted': return 'text-slate-600'
    default: return 'text-slate-500'
  }
}
