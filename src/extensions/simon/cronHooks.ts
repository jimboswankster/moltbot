// Simon-specific cron event hooks (v1)
// This module defines a generic interface so workspaces can route cron events
// without hard-coding behavior into core.

export interface CronEvent {
  jobId?: string; // OpenClaw cron job id, if known
  name?: string; // Friendly job name, if available
  text: string; // systemEvent text payload
  timestampMs: number; // when the event was delivered
}

export interface CronHandleResult {
  handled: boolean; // true if this hook took responsibility for the event
  notes?: string; // optional log/debug notes
}

// Default implementation: no-op. Workspace-specific behavior can be added here.
export async function onCronEvent(_event: CronEvent): Promise<CronHandleResult> {
  return { handled: false };
}
