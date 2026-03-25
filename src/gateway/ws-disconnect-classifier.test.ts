import { describe, expect, it } from "vitest";
import { classifyGatewayDisconnect } from "./ws-disconnect-classifier.js";

describe("classifyGatewayDisconnect", () => {
  it("classifies periodic abnormal client churn", () => {
    expect(
      classifyGatewayDisconnect({
        code: 1006,
        handshake: "connected",
        durationMs: 313_500,
        activeChatRunsForConn: 0,
        lastFrameMethod: "node.list",
      }),
    ).toBe("abnormal_periodic_client_churn");
  });

  it("classifies periodic abnormal churn for proxy keepalive last-frame method", () => {
    expect(
      classifyGatewayDisconnect({
        code: 1006,
        handshake: "connected",
        durationMs: 314_200,
        activeChatRunsForConn: 0,
        lastFrameMethod: "agent.identity.get",
      }),
    ).toBe("abnormal_periodic_client_churn");
  });

  it("classifies short idle churn separately", () => {
    expect(
      classifyGatewayDisconnect({
        code: 1006,
        handshake: "connected",
        durationMs: 101_000,
        activeChatRunsForConn: 0,
        lastFrameMethod: "agent.identity.get",
      }),
    ).toBe("abnormal_idle_short_client_churn");
  });

  it("classifies short idle churn for chat.history separately", () => {
    expect(
      classifyGatewayDisconnect({
        code: 1006,
        handshake: "connected",
        durationMs: 52_000,
        activeChatRunsForConn: 0,
        lastFrameMethod: "chat.history",
      }),
    ).toBe("abnormal_idle_short_client_churn");
  });

  it("classifies abnormal disconnects with active runs", () => {
    expect(
      classifyGatewayDisconnect({
        code: 1006,
        handshake: "connected",
        durationMs: 90_000,
        activeChatRunsForConn: 2,
        lastFrameMethod: "chat.send",
      }),
    ).toBe("abnormal_with_active_runs");
  });

  it("classifies periodic churn with active runs separately", () => {
    expect(
      classifyGatewayDisconnect({
        code: 1006,
        handshake: "connected",
        durationMs: 313_500,
        activeChatRunsForConn: 1,
        lastFrameMethod: "chat.send",
      }),
    ).toBe("abnormal_periodic_client_churn_with_active_runs");
  });

  it("classifies normal/expected closes", () => {
    expect(
      classifyGatewayDisconnect({
        code: 1000,
        handshake: "connected",
        durationMs: 12_000,
        activeChatRunsForConn: 0,
        lastFrameMethod: "node.list",
      }),
    ).toBe("normal_or_expected");
  });

  it("treats remote-access healthcheck closes as expected", () => {
    expect(
      classifyGatewayDisconnect({
        code: 1006,
        handshake: "connected",
        durationMs: 12_000,
        activeChatRunsForConn: 0,
        lastFrameMethod: "node.list",
        userAgent: "remote-access-healthcheck/1",
      }),
    ).toBe("normal_or_expected");
  });
});
