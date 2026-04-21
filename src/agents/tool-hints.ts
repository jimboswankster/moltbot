export type ToolHintContract = {
  schema_version: "hint.contract.v1";
  kind: "tool_failure";
  tool: string;
  lane_chain: string[];
  guidance: {
    mode: "progressive_repair";
    default_detail: "summary";
    escalation_detail: ["medium", "full"];
  };
};

export type ToolHintBundle = {
  retryable: boolean;
  next_action: string;
  hint_commands: string[];
  hint_docs: string[];
  hint_contract: ToolHintContract;
};

type ToolHintCode =
  | "TOOL_READ_MISSING_PARAMETERS"
  | "TOOL_READ_MISSING_PATH"
  | "TOOL_EDIT_MISSING_PARAMETERS"
  | "TOOL_EDIT_MISSING_PATH"
  | "TOOL_EDIT_MISSING_OLD_TEXT"
  | "TOOL_EDIT_MISSING_NEW_TEXT"
  | "TOOL_EDIT_ANCHOR_MISMATCH";

const TOOL_DOCS = {
  read: ["/Users/basecamp/openclaw/docs/tools/index.md"],
  edit: ["/Users/basecamp/openclaw/docs/tools/index.md"],
} as const;

function baseHintContract(tool: "read" | "edit"): ToolHintContract {
  return {
    schema_version: "hint.contract.v1",
    kind: "tool_failure",
    tool,
    lane_chain: [tool, "read", "exec"],
    guidance: {
      mode: "progressive_repair",
      default_detail: "summary",
      escalation_detail: ["medium", "full"],
    },
  };
}

export function buildToolFailureHints(code: ToolHintCode): ToolHintBundle {
  switch (code) {
    case "TOOL_READ_MISSING_PATH":
      return {
        retryable: true,
        next_action: "Retry the read call with a concrete file path.",
        hint_commands: [
          "read(path='relative/or/absolute/file.txt')",
          "exec(command='rg --files . | rg \"<filename-fragment>\"')",
        ],
        hint_docs: [...TOOL_DOCS.read],
        hint_contract: baseHintContract("read"),
      };
    case "TOOL_READ_MISSING_PARAMETERS":
      return {
        retryable: true,
        next_action:
          "Retry the read call with an object payload that includes a concrete file path.",
        hint_commands: [
          "read(path='relative/or/absolute/file.txt')",
          "exec(command='rg --files . | rg \"<filename-fragment>\"')",
        ],
        hint_docs: [...TOOL_DOCS.read],
        hint_contract: baseHintContract("read"),
      };
    case "TOOL_EDIT_MISSING_PARAMETERS":
      return {
        retryable: true,
        next_action:
          "Retry edit with an object payload containing path, oldText, and newText. Read the file first if you are not certain of the exact anchor text.",
        hint_commands: [
          "read(path='relative/or/absolute/file.txt')",
          "edit(path='relative/or/absolute/file.txt', oldText='exact old text', newText='replacement text')",
        ],
        hint_docs: [...TOOL_DOCS.edit],
        hint_contract: baseHintContract("edit"),
      };
    case "TOOL_EDIT_MISSING_PATH":
      return {
        retryable: true,
        next_action: "Retry edit with a concrete file path and read the file first if unsure.",
        hint_commands: [
          "read(path='relative/or/absolute/file.txt')",
          "edit(path='relative/or/absolute/file.txt', oldText='exact old text', newText='replacement text')",
        ],
        hint_docs: [...TOOL_DOCS.edit],
        hint_contract: baseHintContract("edit"),
      };
    case "TOOL_EDIT_MISSING_OLD_TEXT":
      return {
        retryable: true,
        next_action:
          "Read the target file, copy the exact text to replace, then retry edit with oldText.",
        hint_commands: [
          "read(path='relative/or/absolute/file.txt')",
          "edit(path='relative/or/absolute/file.txt', oldText='exact old text', newText='replacement text')",
        ],
        hint_docs: [...TOOL_DOCS.edit],
        hint_contract: baseHintContract("edit"),
      };
    case "TOOL_EDIT_MISSING_NEW_TEXT":
      return {
        retryable: true,
        next_action: "Retry edit with the replacement text in newText.",
        hint_commands: [
          "edit(path='relative/or/absolute/file.txt', oldText='exact old text', newText='replacement text')",
        ],
        hint_docs: [...TOOL_DOCS.edit],
        hint_contract: baseHintContract("edit"),
      };
    case "TOOL_EDIT_ANCHOR_MISMATCH":
      return {
        retryable: true,
        next_action:
          "Use read to capture the exact file contents, then retry edit with an exact oldText match.",
        hint_commands: [
          "read(path='relative/or/absolute/file.txt')",
          "edit(path='relative/or/absolute/file.txt', oldText='exact old text from read', newText='replacement text')",
        ],
        hint_docs: [...TOOL_DOCS.edit],
        hint_contract: baseHintContract("edit"),
      };
  }
}

export type ToolExecutionMetadata = {
  errorCode?: string;
  errorCategory?: string;
  missingKeys?: string[];
  retryable?: boolean;
  nextAction?: string;
  hintCommands?: string[];
  hintDocs?: string[];
  hintContract?: ToolHintContract;
};

export type ToolExecutionError = Error & ToolExecutionMetadata;

export function isToolExecutionMetadata(value: unknown): value is ToolExecutionMetadata {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.errorCode === "string" ||
    typeof record.errorCategory === "string" ||
    Array.isArray(record.missingKeys)
  );
}
