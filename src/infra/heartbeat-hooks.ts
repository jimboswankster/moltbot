// Heartbeat extension hook glue: calls into Simon-specific hooks if present.

import type { HeartbeatContext } from "../extensions/simon/heartbeatHooks.js";
import type { HeartbeatRunResult } from "./heartbeat-wake.js";
import { onHeartbeat as onSimonHeartbeat } from "../extensions/simon/heartbeatHooks.js";

export async function runHeartbeatWithHooks(
  run: (opts: { reason?: string }) => Promise<HeartbeatRunResult>,
  opts: { reason?: string },
): Promise<HeartbeatRunResult> {
  const result = await run(opts);
  if (result.status === "ran") {
    try {
      const ctx: HeartbeatContext = { timestampMs: Date.now() };
      await onSimonHeartbeat(ctx);
    } catch {
      // Swallow extension hook errors to avoid breaking core heartbeat.
    }
  }
  return result;
}
