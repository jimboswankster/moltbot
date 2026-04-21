import type { AgentTool } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import { wrapToolParamNormalization } from "./pi-tools.read.js";
import {
  TOOL_ADVERSARIAL_FAILURE_CORPUS,
  TOOL_ADVERSARIAL_SUCCESS_CORPUS,
} from "./test-fixtures/tool-adversarial-corpus.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createWebSearchTool } from "./tools/web-tools.js";

const mocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(),
}));

vi.mock("../infra/outbound/message-action-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/outbound/message-action-runner.js")>(
    "../infra/outbound/message-action-runner.js",
  );
  return {
    ...actual,
    runMessageAction: mocks.runMessageAction,
  };
});

function requiredGroupsFor(tool: "read" | "edit") {
  if (tool === "read") {
    return [{ keys: ["path", "file_path", "filepath"] }];
  }
  return [
    { keys: ["path", "file_path", "filepath"] },
    { keys: ["oldText", "old_string"] },
    { keys: ["newText", "new_string"] },
  ];
}

function makeWrappedTool(
  tool: "read" | "edit",
  executeImpl?: AgentTool<unknown, unknown>["execute"],
) {
  const base = {
    name: tool,
    label: tool,
    description: `${tool} adversarial corpus test tool`,
    parameters: { type: "object", properties: {} },
    execute:
      executeImpl ??
      (vi.fn(async (_id, args) => ({
        content: [{ type: "text", text: JSON.stringify(args) }],
        details: args,
      })) as AgentTool<unknown, unknown>["execute"]),
  } satisfies AgentTool<unknown, unknown>;

  return wrapToolParamNormalization(base, requiredGroupsFor(tool));
}

describe("tool adversarial corpus", () => {
  describe("replay failure corpus", () => {
    for (const fixture of TOOL_ADVERSARIAL_FAILURE_CORPUS) {
      it(`${fixture.id}: ${fixture.description}`, async () => {
        if (fixture.tool === "message") {
          mocks.runMessageAction.mockReset();
          if (fixture.expected.errorCode === "TOOL_MESSAGE_UNKNOWN_TARGET") {
            mocks.runMessageAction.mockRejectedValueOnce(
              new Error('Unknown target "desk" for Telegram. Hint: <chatId>'),
            );
          }
          const tool = createMessageTool({
            config: {} as never,
            requireExplicitTarget: true,
          });
          const [def] = toToolDefinitions([tool]);
          const result = await def.execute(
            `call:${fixture.id}`,
            fixture.payload,
            undefined,
            undefined,
          );

          expect(result.details).toMatchObject({
            status: "error",
            tool: fixture.tool,
            errorCode: fixture.expected.errorCode,
            errorCategory: fixture.expected.errorCategory,
          });
          if (fixture.expected.retryable !== undefined) {
            expect(result.details).toMatchObject({
              retryable: fixture.expected.retryable,
            });
          }
          const details = result.details as Record<string, unknown>;
          if (fixture.expected.nextActionIncludes) {
            expect(String(details.next_action ?? details.nextAction ?? "")).toContain(
              fixture.expected.nextActionIncludes,
            );
          }
          if (fixture.expected.hintCommandIncludes) {
            const hints = Array.isArray(details.hint_commands)
              ? details.hint_commands
              : Array.isArray(details.hintCommands)
                ? details.hintCommands
                : [];
            expect(hints.join("\n")).toContain(fixture.expected.hintCommandIncludes);
          }
          return;
        }
        if (fixture.tool === "web_search") {
          const priorFetch = global.fetch;
          vi.stubEnv("BRAVE_API_KEY", "test-key");
          const status = fixture.expected.errorCode === "brave_auth_invalid" ? 422 : 429;
          const body =
            fixture.expected.errorCode === "brave_auth_invalid"
              ? JSON.stringify({
                  error: {
                    code: "SUBSCRIPTION_TOKEN_INVALID",
                    detail: "The provided subscription token is invalid.",
                  },
                })
              : "rate limited";
          const mockFetch = vi.fn(() =>
            Promise.resolve({
              ok: false,
              status,
              statusText: status === 422 ? "Unprocessable Entity" : "Too Many Requests",
              text: () => Promise.resolve(body),
            } as Response),
          );
          // @ts-expect-error test fetch stub
          global.fetch = mockFetch;
          try {
            const tool = createWebSearchTool({ config: undefined, sandboxed: true });
            const result = await tool?.execute?.(`call:${fixture.id}`, fixture.payload);
            expect(result?.details).toMatchObject({
              error: fixture.expected.errorCode,
              error_category: fixture.expected.errorCategory,
              retryable: fixture.expected.retryable,
            });
            const details = (result?.details ?? {}) as Record<string, unknown>;
            if (fixture.expected.nextActionIncludes) {
              expect(String(details.next_action ?? "")).toContain(
                fixture.expected.nextActionIncludes,
              );
            }
            if (fixture.expected.hintCommandIncludes) {
              const hints = Array.isArray(details.hint_commands) ? details.hint_commands : [];
              const hintDocs = Array.isArray(details.hint_docs) ? details.hint_docs : [];
              expect([...hints, ...hintDocs].join("\n")).toContain(
                fixture.expected.hintCommandIncludes,
              );
            }
          } finally {
            vi.unstubAllEnvs();
            // @ts-expect-error restore fetch
            global.fetch = priorFetch;
          }
          return;
        }
        const wrapped =
          fixture.expected.errorCode === "TOOL_EDIT_ANCHOR_MISMATCH"
            ? makeWrappedTool(fixture.tool, async () => {
                throw new Error("Could not find the exact text in the file");
              })
            : makeWrappedTool(fixture.tool);
        const [def] = toToolDefinitions([wrapped]);
        const result = await def.execute(
          `call:${fixture.id}`,
          fixture.payload,
          undefined,
          undefined,
        );

        expect(result.details).toMatchObject({
          status: "error",
          tool: fixture.tool,
          errorCode: fixture.expected.errorCode,
          errorCategory: fixture.expected.errorCategory,
        });
        if (fixture.expected.missingKeys) {
          expect(result.details).toMatchObject({
            missingKeys: fixture.expected.missingKeys,
          });
        }
        if (fixture.expected.retryable !== undefined) {
          expect(result.details).toMatchObject({
            retryable: fixture.expected.retryable,
          });
        }
        const details = result.details as Record<string, unknown>;
        if (fixture.expected.nextActionIncludes) {
          expect(String(details.next_action ?? details.nextAction ?? "")).toContain(
            fixture.expected.nextActionIncludes,
          );
        }
        if (fixture.expected.hintCommandIncludes) {
          const hints = Array.isArray(details.hint_commands)
            ? details.hint_commands
            : Array.isArray(details.hintCommands)
              ? details.hintCommands
              : [];
          expect(hints.join("\n")).toContain(fixture.expected.hintCommandIncludes);
        }
      });
    }
  });

  describe("mutation ladder success corpus", () => {
    for (const fixture of TOOL_ADVERSARIAL_SUCCESS_CORPUS) {
      it(`${fixture.id}: ${fixture.description}`, async () => {
        const execute = vi.fn(async (_id, args) => args);
        const wrapped = makeWrappedTool(fixture.tool, execute);

        await wrapped.execute(`call:${fixture.id}`, fixture.payload, undefined, undefined);

        expect(execute).toHaveBeenCalledWith(
          `call:${fixture.id}`,
          fixture.expectedNormalizedArgs,
          undefined,
          undefined,
        );
      });
    }
  });
});
