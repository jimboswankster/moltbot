export type GatewayDisconnectClassificationInput = {
  code: number | null;
  handshake: "pending" | "connected" | "failed";
  durationMs: number;
  activeChatRunsForConn: number;
  lastFrameMethod?: string | null;
  userAgent?: string | null;
};

export type GatewayDisconnectClassification =
  | "abnormal_periodic_client_churn"
  | "abnormal_idle_short_client_churn"
  | "abnormal_periodic_client_churn_with_active_runs"
  | "abnormal_with_active_runs"
  | "normal_or_expected"
  | "other_abnormal";

const PERIODIC_MIN_MS = 240_000;
const PERIODIC_MAX_MS = 360_000;
const IDLE_SHORT_MIN_MS = 45_000;
const PERIODIC_IDLE_METHODS = new Set(["node.list", "agent.identity.get", "chat.history"]);

export function classifyGatewayDisconnect(
  input: GatewayDisconnectClassificationInput,
): GatewayDisconnectClassification {
  const userAgent = (input.userAgent || "").toLowerCase();
  if (userAgent.includes("remote-access-healthcheck")) {
    return "normal_or_expected";
  }

  if (input.code === 1000 || input.code === 1001 || input.code === 1012) {
    return "normal_or_expected";
  }

  if (input.code === 1006 && input.handshake === "connected") {
    const withinPeriodicWindow =
      input.durationMs >= PERIODIC_MIN_MS && input.durationMs <= PERIODIC_MAX_MS;
    const lastMethod = String(input.lastFrameMethod || "").trim();
    const isPeriodicIdleMethod = PERIODIC_IDLE_METHODS.has(lastMethod);
    if (input.activeChatRunsForConn > 0 && withinPeriodicWindow) {
      return "abnormal_periodic_client_churn_with_active_runs";
    }
    if (input.activeChatRunsForConn > 0) {
      return "abnormal_with_active_runs";
    }
    if (!withinPeriodicWindow && input.durationMs >= IDLE_SHORT_MIN_MS && isPeriodicIdleMethod) {
      return "abnormal_idle_short_client_churn";
    }
    if (withinPeriodicWindow && isPeriodicIdleMethod) {
      return "abnormal_periodic_client_churn";
    }
  }

  return "other_abnormal";
}
