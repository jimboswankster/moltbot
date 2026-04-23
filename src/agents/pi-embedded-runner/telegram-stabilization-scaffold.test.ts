import { describe, expect, it } from "vitest";
import {
  buildTelegramStabilizationRepairPrompt,
  isTelegramStabilizationPreferredFirstStepTool,
  resolveTelegramStabilizationScaffold,
  resolveTelegramStabilizationToolUseGuardMode,
} from "./telegram-stabilization-scaffold.js";

describe("telegram stabilization scaffold", () => {
  it("resolves the federated master scaffold for telegram stabilization", () => {
    const scaffold = resolveTelegramStabilizationScaffold("telegram-codex-stabilization");
    expect(scaffold?.id).toBe("telegram_federated_master");
    expect(scaffold?.preferredFirstStep).toEqual([
      "read",
      "exec",
      "sessions_history",
      "session_status",
      "message",
    ]);
  });

  it("renders a repair prompt from the scaffold", () => {
    const scaffold = resolveTelegramStabilizationScaffold("telegram-codex-stabilization");
    expect(scaffold).toBeTruthy();
    const prompt = buildTelegramStabilizationRepairPrompt(scaffold!);
    expect(prompt).toContain(
      "Your previous attempt failed because it did not produce a usable tool-backed result.",
    );
    expect(prompt).toContain("`read`, `exec`, `sessions_history`, `session_status`, `message`");
    expect(prompt).toContain("Secondary tools: `write`, `edit`, `apply_patch`");
  });

  it("classifies in-tier first-step tools deterministically", () => {
    const scaffold = resolveTelegramStabilizationScaffold("telegram-codex-stabilization");
    expect(isTelegramStabilizationPreferredFirstStepTool(scaffold, "read")).toBe(true);
    expect(isTelegramStabilizationPreferredFirstStepTool(scaffold, "web_search")).toBe(false);
    expect(isTelegramStabilizationPreferredFirstStepTool(scaffold, null)).toBeNull();
  });

  it("defaults the tool-use guard mode to diagnostic for stabilization lanes", () => {
    expect(
      resolveTelegramStabilizationToolUseGuardMode({
        trustedTaskClass: "telegram-codex-stabilization",
      }),
    ).toBe("diagnostic");
  });

  it("resolves guard mode to off outside stabilization lanes", () => {
    expect(
      resolveTelegramStabilizationToolUseGuardMode({
        trustedTaskClass: "policy-review",
      }),
    ).toBe("off");
  });
});
