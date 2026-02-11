import type { CronJob, CronMessageChannel } from "./types.js";

export type CronDeliveryPlan = {
  requested: boolean;
  channel?: CronMessageChannel;
  to?: string;
};

/**
 * Resolves whether delivery is requested for a cron job and the target channel/to.
 */
export function resolveCronDeliveryPlan(job: CronJob): CronDeliveryPlan {
  if (job.payload.kind !== "agentTurn") {
    return { requested: false };
  }
  const p = job.payload;
  const requested = p.deliver === true;
  return {
    requested,
    channel: p.channel,
    to: p.to,
  };
}
