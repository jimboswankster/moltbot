export type ToolAdversarialFailureFixture = {
  id: string;
  source: "telemetry_replay" | "mutation_ladder";
  tool: "read" | "edit" | "message" | "web_search";
  description: string;
  telemetryRef?: string;
  payload: unknown;
  expected: {
    errorCode: string;
    errorCategory: string;
    missingKeys?: string[];
    retryable?: boolean;
    nextActionIncludes?: string;
    hintCommandIncludes?: string;
  };
};

export type ToolAdversarialSuccessFixture = {
  id: string;
  source: "mutation_ladder";
  tool: "read" | "edit";
  description: string;
  payload: unknown;
  expectedNormalizedArgs: Record<string, unknown>;
};

export const TOOL_ADVERSARIAL_FAILURE_CORPUS: ToolAdversarialFailureFixture[] = [
  {
    id: "read.telemetry.pathless_object",
    source: "telemetry_replay",
    tool: "read",
    description: "Replay historical pathless object call behind read start warnings.",
    payload: {},
    expected: {
      errorCode: "TOOL_READ_MISSING_PATH",
      errorCategory: "missing_required_param",
      missingKeys: ["path"],
      retryable: true,
      nextActionIncludes: "concrete file path",
      hintCommandIncludes: "read(path=",
    },
  },
  {
    id: "read.telemetry.pathless_nested_wrong_field",
    source: "telemetry_replay",
    tool: "read",
    description:
      "Replay malformed nested payload where input exists but no path survives normalization.",
    payload: { input: { oldText: "x" } },
    expected: {
      errorCode: "TOOL_READ_MISSING_PATH",
      errorCategory: "missing_required_param",
      missingKeys: ["path"],
      retryable: true,
      nextActionIncludes: "concrete file path",
      hintCommandIncludes: "rg --files",
    },
  },
  {
    id: "read.live_2026_04_20.pathless_object_repeat",
    source: "telemetry_replay",
    tool: "read",
    description:
      "Replay the April 20, 2026 Telegram-lane pathless read family that still appeared after local hardening.",
    telemetryRef:
      "gateway.err.log: 2026-04-20T13:00-13:03Z repeated `read tool called without path` entries",
    payload: {},
    expected: {
      errorCode: "TOOL_READ_MISSING_PATH",
      errorCategory: "missing_required_param",
      missingKeys: ["path"],
      retryable: true,
      nextActionIncludes: "concrete file path",
      hintCommandIncludes: "read(path=",
    },
  },
  {
    id: "read.mutation.non_object_payload",
    source: "mutation_ladder",
    tool: "read",
    description: "Completely malformed non-object payload still needs repair guidance.",
    payload: null,
    expected: {
      errorCode: "TOOL_READ_MISSING_PARAMETERS",
      errorCategory: "missing_required_param",
      missingKeys: ["path"],
      retryable: true,
      nextActionIncludes: "object payload",
      hintCommandIncludes: "read(path=",
    },
  },
  {
    id: "edit.telemetry.missing_old_text",
    source: "telemetry_replay",
    tool: "edit",
    description: "Replay frequent production edit attempt missing oldText/old_string.",
    payload: { path: "foo.txt", newText: "after" },
    expected: {
      errorCode: "TOOL_EDIT_MISSING_OLD_TEXT",
      errorCategory: "missing_required_param",
      missingKeys: ["oldText"],
      retryable: true,
      nextActionIncludes: "Read the target file",
      hintCommandIncludes: "read(path=",
    },
  },
  {
    id: "edit.live_2026_04_20.missing_old_text_repeat",
    source: "telemetry_replay",
    tool: "edit",
    description:
      "Replay the April 20, 2026 repeated edit calls that still omitted oldText in live telemetry.",
    telemetryRef:
      "gateway.err.log: 2026-04-20T13:03:38Z and nearby repeated `Missing required parameter: oldText` entries",
    payload: { path: "foo.txt", newText: "after" },
    expected: {
      errorCode: "TOOL_EDIT_MISSING_OLD_TEXT",
      errorCategory: "missing_required_param",
      missingKeys: ["oldText"],
      retryable: true,
      nextActionIncludes: "Read the target file",
      hintCommandIncludes: "read(path=",
    },
  },
  {
    id: "edit.mutation.missing_new_text",
    source: "mutation_ladder",
    tool: "edit",
    description: "Near-valid edit mutation that drops only newText.",
    payload: { path: "foo.txt", oldText: "before" },
    expected: {
      errorCode: "TOOL_EDIT_MISSING_NEW_TEXT",
      errorCategory: "missing_required_param",
      missingKeys: ["newText"],
      retryable: true,
      nextActionIncludes: "replacement text",
      hintCommandIncludes: "edit(path=",
    },
  },
  {
    id: "edit.mutation.non_object_payload",
    source: "mutation_ladder",
    tool: "edit",
    description:
      "Completely malformed non-object payload should still produce actionable repair guidance.",
    payload: null,
    expected: {
      errorCode: "TOOL_EDIT_MISSING_PARAMETERS",
      errorCategory: "missing_required_param",
      missingKeys: ["path", "oldText", "newText"],
      retryable: true,
      nextActionIncludes: "path, oldText, and newText",
      hintCommandIncludes: "read(path=",
    },
  },
  {
    id: "message.telemetry.missing_target",
    source: "telemetry_replay",
    tool: "message",
    description: "Replay recurring send attempt with no explicit target.",
    payload: { action: "send", message: "hi" },
    expected: {
      errorCode: "TOOL_MESSAGE_MISSING_TARGET",
      errorCategory: "invalid_arguments",
      retryable: true,
      nextActionIncludes: "explicit target",
      hintCommandIncludes: "message(action='send', target='telegram:<chatId>'",
    },
  },
  {
    id: "message.telemetry.unknown_target_handle",
    source: "telemetry_replay",
    tool: "message",
    description: "Replay recurring Telegram unknown-target failure with a natural-language handle.",
    payload: { action: "send", target: "desk", message: "hi" },
    expected: {
      errorCode: "TOOL_MESSAGE_UNKNOWN_TARGET",
      errorCategory: "invalid_arguments",
      retryable: true,
      nextActionIncludes: "valid target id",
      hintCommandIncludes: "message(action='send', target='telegram:<chatId>'",
    },
  },
  {
    id: "web_search.telemetry.brave_auth_invalid",
    source: "telemetry_replay",
    tool: "web_search",
    description: "Replay recurring Brave invalid-subscription-token provider failure.",
    payload: { query: "test" },
    expected: {
      errorCode: "brave_auth_invalid",
      errorCategory: "provider_auth_invalid",
      retryable: false,
      nextActionIncludes: "BRAVE_API_KEY",
      hintCommandIncludes: "openclaw configure --section web",
    },
  },
  {
    id: "web_search.telemetry.brave_rate_limited",
    source: "telemetry_replay",
    tool: "web_search",
    description: "Replay recurring Brave rate-limit degradation.",
    payload: { query: "test" },
    expected: {
      errorCode: "brave_rate_limited",
      errorCategory: "provider_rate_limited",
      retryable: true,
      nextActionIncludes: "Wait briefly",
      hintCommandIncludes: "docs.openclaw.ai/tools/web",
    },
  },
];

export const TOOL_ADVERSARIAL_SUCCESS_CORPUS: ToolAdversarialSuccessFixture[] = [
  {
    id: "read.mutation.prefer_top_level_path_over_nested_alias",
    source: "mutation_ladder",
    tool: "read",
    description:
      "When both top-level path and nested filepath exist, top-level path should win deterministically.",
    payload: {
      path: "authoritative.txt",
      input: { filepath: "nested.txt" },
      tool_id: "read-1",
    },
    expectedNormalizedArgs: {
      path: "authoritative.txt",
      tool_id: "read-1",
    },
  },
  {
    id: "edit.mutation.prefer_top_level_semantic_fields_over_nested_aliases",
    source: "mutation_ladder",
    tool: "edit",
    description: "Top-level normalized semantic fields should win over nested alias fallbacks.",
    payload: {
      path: "authoritative.txt",
      oldText: "top-level-before",
      newText: "top-level-after",
      input: {
        filepath: "nested.txt",
        old_string: "nested-before",
        new_string: "nested-after",
      },
    },
    expectedNormalizedArgs: {
      path: "authoritative.txt",
      oldText: "top-level-before",
      newText: "top-level-after",
    },
  },
];
