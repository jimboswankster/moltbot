export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  /**
   * Default model for isolated cron agentTurn jobs when payload.model is omitted or "default".
   * Use a cheap orchestrator model for background work.
   */
  agentTurnModel?: string;
};
