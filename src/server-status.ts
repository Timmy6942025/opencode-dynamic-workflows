export type ServerStatusStage =
  | "idle"
  | "checking"
  | "starting"
  | "polling"
  | "ready"
  | "failed"

export interface ServerStatus {
  stage: ServerStatusStage
  message: string
  baseUrl: string
  startedAt?: number
  elapsedMs?: number
  error?: string
}

let currentStatus: ServerStatus = {
  stage: "idle",
  message: "No connection attempt made yet",
  baseUrl: "http://localhost:4096",
}

export function getServerStatus(): ServerStatus {
  if (currentStatus.startedAt) {
    return {
      ...currentStatus,
      elapsedMs: Date.now() - currentStatus.startedAt,
    }
  }
  return currentStatus
}

export function updateServerStatus(partial: Partial<ServerStatus>): void {
  currentStatus = { ...currentStatus, ...partial }
}

export function resetServerStatus(): void {
  currentStatus = {
    stage: "idle",
    message: "No connection attempt made yet",
    baseUrl: currentStatus.baseUrl,
  }
}
