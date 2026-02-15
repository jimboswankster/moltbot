import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAuthProfileOrder } from "./auth-profiles.js";
import { resetKloopPolicyCacheForTest } from "./auth-profiles/kloop-policy.js";

describe("resolveAuthProfileOrder kloop policy integration", () => {
  const originalStatePath = process.env.OPENCLAW_KLOOP_STATE_PATH;

  afterEach(() => {
    if (originalStatePath === undefined) {
      delete process.env.OPENCLAW_KLOOP_STATE_PATH;
    } else {
      process.env.OPENCLAW_KLOOP_STATE_PATH = originalStatePath;
    }
    resetKloopPolicyCacheForTest();
  });

  it("moves breaker-open profiles behind available profiles", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-kloop-order-"));
    const statePath = path.join(tempDir, "free-engine-kloop-state.json");
    const future = Date.now() + 5 * 60_000;
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          routes: {
            "groq:default": {
              routeId: "default",
              provider: "groq",
              breakerState: "open",
              inferredCooldownUntil: future,
            },
            "groq:envrr-BlabnDev_Route1": {
              routeId: "envrr-BlabnDev_Route1",
              provider: "groq",
              breakerState: "closed",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    process.env.OPENCLAW_KLOOP_STATE_PATH = statePath;
    resetKloopPolicyCacheForTest();

    const order = resolveAuthProfileOrder({
      store: {
        version: 1,
        profiles: {
          "groq:default": { type: "api_key", provider: "groq", key: "sk-a" },
          "groq:envrr-BlabnDev_Route1": { type: "api_key", provider: "groq", key: "sk-b" },
        },
        order: {
          groq: ["groq:default", "groq:envrr-BlabnDev_Route1"],
        },
      },
      provider: "groq",
    });

    expect(order).toEqual(["groq:envrr-BlabnDev_Route1", "groq:default"]);
  });
});
