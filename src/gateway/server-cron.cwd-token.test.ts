import { describe, expect, it } from "vitest";
import { resolveCronCommandCwd } from "./server-cron.js";

describe("resolveCronCommandCwd", () => {
  it("uses workspace fallback when cwd is missing", () => {
    expect(resolveCronCommandCwd({ workspaceDir: "/tmp/ws" })).toBe("/tmp/ws");
  });

  it("resolves workspace token", () => {
    expect(
      resolveCronCommandCwd({
        cwd: "__OPENCLAW_WORKSPACE__",
        workspaceDir: "/tmp/ws",
      }),
    ).toBe("/tmp/ws");
  });

  it("resolves workspace os token", () => {
    expect(
      resolveCronCommandCwd({
        cwd: "__OPENCLAW_WORKSPACE_OS__",
        workspaceDir: "/tmp/ws",
      }),
    ).toBe("/tmp/ws/os");
  });

  it("passes through explicit cwd", () => {
    expect(
      resolveCronCommandCwd({
        cwd: "/tmp/custom",
        workspaceDir: "/tmp/ws",
      }),
    ).toBe("/tmp/custom");
  });
});
