// Cron service extension hook glue: calls into Simon-specific cron hooks if present.

import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { onCronEvent as onSimonCronEvent } from "../../extensions/simon/cronHooks.js";

export async function runCronHooksForMainJob(state: CronServiceState, job: CronJob) {
  const text = job.payload?.kind === "systemEvent" ? job.payload.text : undefined;
  if (!text) {
    return;
  }
  const nowMs = state.deps.nowMs();
  try {
    await onSimonCronEvent({
      jobId: job.id,
      name: job.name,
      text,
      timestampMs: nowMs,
    });
  } catch {
    // Swallow extension hook errors to avoid breaking core cron behavior.
  }
}
