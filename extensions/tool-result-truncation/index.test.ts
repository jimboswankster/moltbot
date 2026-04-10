import { describe, expect, it } from "vitest";
import toolResultTruncationPlugin from "./index.js";

type HookHandler = (
  event: unknown,
  ctx: { workspaceDir?: string },
) => { message?: unknown } | undefined;

function createMockApi(pluginConfig?: unknown) {
  const hooks = new Map<string, HookHandler>();
  const warnings: string[] = [];
  return {
    hooks,
    warnings,
    api: {
      pluginConfig,
      logger: {
        warn: (message: string) => warnings.push(message),
      },
      on: (hookName: "tool_result_persist", handler: HookHandler) => {
        hooks.set(hookName, handler);
      },
    },
  };
}

function buildOversizedMessage(length = 6000) {
  return {
    role: "toolResult",
    content: [
      {
        type: "text",
        text: `start\n${"x".repeat(length)}\nend`,
      },
    ],
  };
}

describe("tool-result-truncation plugin", () => {
  it("uses the incumbent truncation behavior by default", () => {
    const { api, hooks } = createMockApi();
    toolResultTruncationPlugin.register(api);

    const handler = hooks.get("tool_result_persist");
    const result = handler?.({ message: buildOversizedMessage() }, {});
    const text = (result as { message: { content: Array<{ text: string }> } }).message.content[0].text;

    expect(text).toContain("showing first 2000 and last 500 chars");
  });

  it("activates the tighter candidate only on allowed workspaces", () => {
    const allowedWorkspace = "/tmp/allowed";
    const { api, hooks } = createMockApi({
      variantId: "diagnostic-signal-tight-marker",
      allowedWorkspacePrefixes: [allowedWorkspace],
    });
    toolResultTruncationPlugin.register(api);

    const handler = hooks.get("tool_result_persist");
    const allowed = handler?.({ message: buildOversizedMessage() }, { workspaceDir: allowedWorkspace });
    const blocked = handler?.({ message: buildOversizedMessage() }, { workspaceDir: "/tmp/blocked" });

    const allowedText = (allowed as { message: { content: Array<{ text: string }> } }).message.content[0]
      .text;
    const blockedText = (blocked as { message: { content: Array<{ text: string }> } }).message.content[0]
      .text;

    expect(allowedText).toContain("[...trimmed...]");
    expect(blockedText).toContain("showing first 2000 and last 500 chars");
    expect(allowedText.length).toBeLessThan(blockedText.length);
  });

  it("refuses to activate the candidate without an explicit allowlist", () => {
    const { api, hooks, warnings } = createMockApi({
      variantId: "diagnostic-signal-tight-marker",
    });
    toolResultTruncationPlugin.register(api);

    const handler = hooks.get("tool_result_persist");
    const result = handler?.({ message: buildOversizedMessage() }, { workspaceDir: "/tmp/anywhere" });
    const text = (result as { message: { content: Array<{ text: string }> } }).message.content[0].text;

    expect(text).toContain("showing first 2000 and last 500 chars");
    expect(warnings).toEqual([
      "tool-result-truncation: candidate variant configured without allowedWorkspacePrefixes; preserving incumbent behavior",
    ]);
  });
});
