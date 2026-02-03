// Simon-specific heartbeat hooks (v1)
// Optional extension point for light-weight periodic background work.

export interface HeartbeatContext {
  timestampMs: number;
  // Additional fields (like recent message summaries) can be added later.
}

// Default implementation: no-op.
export async function onHeartbeat(_ctx: HeartbeatContext): Promise<void> {
  return;
}
