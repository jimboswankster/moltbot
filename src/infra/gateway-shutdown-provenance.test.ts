import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeRecentGatewayShutdownIntentSync,
  resolveGatewayShutdownIntentPath,
  writeGatewayShutdownIntentSync,
} from "./gateway-shutdown-provenance.js";

describe("gateway shutdown provenance", () => {
  const env = {
    ...process.env,
    HOME: path.join(os.tmpdir(), `openclaw-gateway-intent-${process.pid}`),
  };

  afterEach(() => {
    fs.rmSync(env.HOME, { recursive: true, force: true });
  });

  it("writes and consumes a recent shutdown intent", () => {
    const filePath = writeGatewayShutdownIntentSync(
      {
        initiator: "hydra.gateway.stop",
        action: "stop",
        reason: "manual_restart",
        details: { source: "test" },
      },
      env,
    );
    expect(fs.existsSync(filePath)).toBe(true);

    const parsed = consumeRecentGatewayShutdownIntentSync({ env, maxAgeMs: 60_000 });
    expect(parsed?.initiator).toBe("hydra.gateway.stop");
    expect(parsed?.action).toBe("stop");
    expect(parsed?.reason).toBe("manual_restart");
    expect(fs.existsSync(resolveGatewayShutdownIntentPath(env))).toBe(false);
  });

  it("ignores stale intents", () => {
    writeGatewayShutdownIntentSync(
      {
        initiator: "hydra.gateway.restart",
        action: "restart",
        ts: new Date(Date.now() - 120_000).toISOString(),
      },
      env,
    );

    const parsed = consumeRecentGatewayShutdownIntentSync({ env, maxAgeMs: 30_000 });
    expect(parsed).toBeNull();
  });
});
