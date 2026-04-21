import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const tool = {
      name: "boom",
      label: "Boom",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call1", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("nope");
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call2", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  it("preserves structured tool hint metadata in error results", async () => {
    const tool = {
      name: "read",
      label: "Read",
      description: "throws",
      parameters: {},
      execute: async () => {
        const err = new Error("Missing required parameter: path") as Error & {
          errorCode?: string;
          errorCategory?: string;
          missingKeys?: string[];
          retryable?: boolean;
          nextAction?: string;
        };
        err.errorCode = "TOOL_READ_MISSING_PATH";
        err.errorCategory = "missing_required_param";
        err.missingKeys = ["path"];
        err.retryable = true;
        err.nextAction = "Retry the read call with a concrete file path.";
        throw err;
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call3", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      status: "error",
      tool: "read",
      errorCode: "TOOL_READ_MISSING_PATH",
      errorCategory: "missing_required_param",
      missingKeys: ["path"],
      retryable: true,
      nextAction: "Retry the read call with a concrete file path.",
    });
  });
});
