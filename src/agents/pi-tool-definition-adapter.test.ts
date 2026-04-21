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
      next_action: "Retry the read call with a concrete file path.",
    });
  });

  it("mirrors hint metadata using mission-control-style snake_case keys", async () => {
    const tool = {
      name: "edit",
      label: "Edit",
      description: "throws",
      parameters: {},
      execute: async () => {
        const err = new Error("Missing parameters for edit") as Error & {
          errorCode?: string;
          errorCategory?: string;
          missingKeys?: string[];
          retryable?: boolean;
          nextAction?: string;
          hintCommands?: string[];
          hintDocs?: string[];
          hintContract?: Record<string, unknown>;
        };
        err.errorCode = "TOOL_EDIT_MISSING_PARAMETERS";
        err.errorCategory = "missing_required_param";
        err.missingKeys = ["path", "oldText", "newText"];
        err.retryable = true;
        err.nextAction = "Retry edit with an object payload containing path, oldText, and newText.";
        err.hintCommands = [
          "read(path='file.txt')",
          "edit(path='file.txt', oldText='a', newText='b')",
        ];
        err.hintDocs = ["/Users/basecamp/openclaw/docs/tools/index.md"];
        err.hintContract = { schema_version: "hint.contract.v1" };
        throw err;
      },
    } satisfies AgentTool<unknown, unknown>;

    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call4", {}, undefined, undefined);

    expect(result.details).toMatchObject({
      nextAction: "Retry edit with an object payload containing path, oldText, and newText.",
      next_action: "Retry edit with an object payload containing path, oldText, and newText.",
      hintCommands: ["read(path='file.txt')", "edit(path='file.txt', oldText='a', newText='b')"],
      hint_commands: ["read(path='file.txt')", "edit(path='file.txt', oldText='a', newText='b')"],
      hintDocs: ["/Users/basecamp/openclaw/docs/tools/index.md"],
      hint_docs: ["/Users/basecamp/openclaw/docs/tools/index.md"],
      hintContract: { schema_version: "hint.contract.v1" },
      hint_contract: { schema_version: "hint.contract.v1" },
    });
  });
});
