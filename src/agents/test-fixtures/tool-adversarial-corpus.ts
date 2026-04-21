export type ToolAdversarialFailureFixture = {
  id: string;
  source: "telemetry_replay" | "mutation_ladder";
  tool: "read" | "edit" | "message";
  description: string;
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
