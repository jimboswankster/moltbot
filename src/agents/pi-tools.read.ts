import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { detectMime } from "../media/mime.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import { buildToolFailureHints, type ToolExecutionError } from "./tool-hints.js";
import { sanitizeToolResultImages } from "./tool-images.js";

// NOTE(steipete): Upstream read now does file-magic MIME detection; we keep the wrapper
// to normalize payloads and sanitize oversized images before they hit providers.
type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

async function sniffMimeFromBase64(base64: string): Promise<{
  mimeType?: string;
  decodeFailed?: boolean;
}> {
  const trimmed = base64.trim();
  if (!trimmed) {
    return {};
  }

  const take = Math.min(256, trimmed.length);
  const sliceLen = take - (take % 4);
  if (sliceLen < 8) {
    return {};
  }

  try {
    const head = Buffer.from(trimmed.slice(0, sliceLen), "base64");
    return { mimeType: await detectMime({ buffer: head }) };
  } catch {
    return { decodeFailed: true };
  }
}

function rewriteReadImageHeader(text: string, mimeType: string): string {
  // pi-coding-agent uses: "Read image file [image/png]"
  if (text.startsWith("Read image file [") && text.endsWith("]")) {
    return `Read image file [${mimeType}]`;
  }
  return text;
}

async function normalizeReadImageResult(
  result: AgentToolResult<unknown>,
  filePath: string,
): Promise<{
  result: AgentToolResult<unknown>;
  diagnostics: Array<{ code: string; message: string }>;
}> {
  const diagnostics: Array<{ code: string; message: string }> = [];
  const content = Array.isArray(result.content) ? result.content : [];

  const image = content.find(
    (b): b is ImageContentBlock =>
      !!b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { data?: unknown }).data === "string" &&
      typeof (b as { mimeType?: unknown }).mimeType === "string",
  );
  if (!image) {
    return { result, diagnostics };
  }

  if (!image.data.trim()) {
    throw new Error(`read: image payload is empty (${filePath})`);
  }

  const sniff = await sniffMimeFromBase64(image.data);
  if (sniff.decodeFailed) {
    diagnostics.push({
      code: "read_mime_sniff_failed",
      message: `read: failed to decode image header for MIME sniff (${filePath})`,
    });
  }
  const sniffed = sniff.mimeType;
  if (!sniffed) {
    return { result, diagnostics };
  }

  if (!sniffed.startsWith("image/")) {
    throw new Error(
      `read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`,
    );
  }

  if (sniffed === image.mimeType) {
    return { result, diagnostics };
  }

  const nextContent = content.map((block) => {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
      const b = block as ImageContentBlock & { mimeType: string };
      return { ...b, mimeType: sniffed } satisfies ImageContentBlock;
    }
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const b = block as TextContentBlock & { text: string };
      return {
        ...b,
        text: rewriteReadImageHeader(b.text, sniffed),
      } satisfies TextContentBlock;
    }
    return block;
  });

  return { result: { ...result, content: nextContent }, diagnostics };
}

type RequiredParamGroup = {
  keys: readonly string[];
  allowEmpty?: boolean;
  label?: string;
};

export const CLAUDE_PARAM_GROUPS = {
  read: [
    { keys: ["path", "file_path", "filepath"], label: "path (path or file_path or filepath)" },
  ],
  write: [
    { keys: ["path", "file_path", "filepath"], label: "path (path or file_path or filepath)" },
  ],
  edit: [
    { keys: ["path", "file_path", "filepath"], label: "path (path or file_path or filepath)" },
    {
      keys: ["oldText", "old_string"],
      label: "oldText (oldText or old_string)",
    },
    {
      keys: ["newText", "new_string"],
      label: "newText (newText or new_string)",
    },
  ],
} as const;

// Normalize tool parameters from Claude Code conventions to pi-coding-agent conventions.
// Claude Code uses file_path/old_string/new_string while pi-coding-agent uses path/oldText/newText.
// This prevents models trained on Claude Code from getting stuck in tool-call loops.
export function normalizeToolParams(params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const normalized = { ...record };
  // Some providers/agent wrappers emit tool args under an `input` envelope.
  // Flatten known wrapped args before alias normalization.
  if (
    "input" in normalized &&
    normalized.input &&
    typeof normalized.input === "object" &&
    !Array.isArray(normalized.input)
  ) {
    const input = normalized.input as Record<string, unknown>;
    for (const [key, value] of Object.entries(input)) {
      if (!(key in normalized)) {
        normalized[key] = value;
      }
    }
    delete normalized.input;
  }
  // file_path/filepath → path (read, write, edit)
  if ("file_path" in normalized && !("path" in normalized)) {
    normalized.path = normalized.file_path;
    delete normalized.file_path;
  }
  if ("filepath" in normalized && !("path" in normalized)) {
    normalized.path = normalized.filepath;
    delete normalized.filepath;
  }
  // old_string → oldText (edit)
  if ("old_string" in normalized && !("oldText" in normalized)) {
    normalized.oldText = normalized.old_string;
    delete normalized.old_string;
  }
  // new_string → newText (edit)
  if ("new_string" in normalized && !("newText" in normalized)) {
    normalized.newText = normalized.new_string;
    delete normalized.new_string;
  }
  return normalized;
}

export function patchToolSchemaForClaudeCompatibility(tool: AnyAgentTool): AnyAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === "object"
      ? (tool.parameters as Record<string, unknown>)
      : undefined;

  if (!schema || !schema.properties || typeof schema.properties !== "object") {
    return tool;
  }

  const properties = { ...(schema.properties as Record<string, unknown>) };
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : [];
  let changed = false;

  const aliasPairs: Array<{ original: string; alias: string }> = [
    { original: "path", alias: "file_path" },
    { original: "path", alias: "filepath" },
    { original: "oldText", alias: "old_string" },
    { original: "newText", alias: "new_string" },
  ];

  for (const { original, alias } of aliasPairs) {
    if (!(original in properties)) {
      continue;
    }
    if (!(alias in properties)) {
      properties[alias] = properties[original];
      changed = true;
    }
    const idx = required.indexOf(original);
    if (idx !== -1) {
      required.splice(idx, 1);
      changed = true;
    }
  }

  if (!changed) {
    return tool;
  }

  return {
    ...tool,
    parameters: {
      ...schema,
      properties,
      required,
    },
  };
}

export function assertRequiredParams(
  record: Record<string, unknown> | undefined,
  groups: readonly RequiredParamGroup[],
  toolName: string,
): void {
  if (!record || typeof record !== "object") {
    const hintCode =
      toolName === "read"
        ? "TOOL_READ_MISSING_PARAMETERS"
        : toolName === "edit"
          ? "TOOL_EDIT_MISSING_PARAMETERS"
          : undefined;
    const hintBundle = hintCode ? buildToolFailureHints(hintCode) : undefined;
    const err = new Error(`Missing parameters for ${toolName}`) as ToolExecutionError;
    err.errorCode = hintCode ?? `TOOL_${toolName.toUpperCase()}_MISSING_PARAMETERS`;
    err.errorCategory = "missing_required_param";
    err.missingKeys = groups.map((group) => group.keys[0] ?? "unknown");
    if (hintBundle) {
      err.retryable = hintBundle.retryable;
      err.nextAction = hintBundle.next_action;
      err.hintCommands = hintBundle.hint_commands;
      err.hintDocs = hintBundle.hint_docs;
      err.hintContract = hintBundle.hint_contract;
    }
    throw err;
  }

  for (const group of groups) {
    const satisfied = group.keys.some((key) => {
      if (!(key in record)) {
        return false;
      }
      const value = record[key];
      if (typeof value !== "string") {
        return false;
      }
      if (group.allowEmpty) {
        return true;
      }
      return value.trim().length > 0;
    });

    if (!satisfied) {
      const label = group.label ?? group.keys.join(" or ");
      const primaryKey = group.keys[0] ?? "unknown";
      const hintCode =
        toolName === "read"
          ? "TOOL_READ_MISSING_PATH"
          : toolName === "edit" && primaryKey === "path"
            ? "TOOL_EDIT_MISSING_PATH"
            : toolName === "edit" && primaryKey === "oldText"
              ? "TOOL_EDIT_MISSING_OLD_TEXT"
              : toolName === "edit" && primaryKey === "newText"
                ? "TOOL_EDIT_MISSING_NEW_TEXT"
                : undefined;
      const hintBundle = hintCode ? buildToolFailureHints(hintCode) : undefined;
      const err = new Error(`Missing required parameter: ${label}`) as ToolExecutionError;
      err.errorCode =
        hintCode ?? `TOOL_${toolName.toUpperCase()}_MISSING_${primaryKey.toUpperCase()}`;
      err.errorCategory = "missing_required_param";
      err.missingKeys = [primaryKey];
      if (hintBundle) {
        err.retryable = hintBundle.retryable;
        err.nextAction = hintBundle.next_action;
        err.hintCommands = hintBundle.hint_commands;
        err.hintDocs = hintBundle.hint_docs;
        err.hintContract = hintBundle.hint_contract;
      }
      throw err;
    }
  }
}

function enhanceFsError(err: unknown, toolName: string, path?: string): unknown {
  if (!(err instanceof Error)) return err;

  const msg = err.message;
  let hint = "";

  if (msg.includes("ENOENT") || msg.includes("no such file")) {
    hint = `Hint: File not found at '${path || "path"}'. Use 'ls -R' or 'find' to locate it.`;
  } else if (msg.includes("EACCES") || msg.includes("permission denied")) {
    hint = `Hint: Permission denied for '${path || "path"}'. Check file permissions.`;
  } else if (msg.includes("EISDIR") || msg.includes("illegal operation on a directory")) {
    hint = `Hint: '${path || "path"}' is a directory, not a file.`;
  } else if (toolName === "edit" && msg.includes("Could not find the exact text")) {
    hint =
      "Hint: The 'oldText' must match EXACTLY, including whitespace and newlines. Use 'read' to get the exact content first.";
    const toolErr = err as ToolExecutionError;
    const hintBundle = buildToolFailureHints("TOOL_EDIT_ANCHOR_MISMATCH");
    toolErr.errorCode = "TOOL_EDIT_ANCHOR_MISMATCH";
    toolErr.errorCategory = "content_anchor_mismatch";
    toolErr.retryable = hintBundle.retryable;
    toolErr.nextAction = hintBundle.next_action;
    toolErr.hintCommands = hintBundle.hint_commands;
    toolErr.hintDocs = hintBundle.hint_docs;
    toolErr.hintContract = hintBundle.hint_contract;
  }

  if (hint) {
    err.message = `${msg}\n\n${hint}`;
  }
  return err;
}

// Generic wrapper to normalize parameters for any tool
export function wrapToolParamNormalization(
  tool: AnyAgentTool,
  requiredParamGroups?: readonly RequiredParamGroup[],
): AnyAgentTool {
  const patched = patchToolSchemaForClaudeCompatibility(tool);
  return {
    ...patched,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);

      try {
        if (requiredParamGroups?.length) {
          assertRequiredParams(record, requiredParamGroups, tool.name);
        }
        return await tool.execute(toolCallId, normalized ?? params, signal, onUpdate);
      } catch (err) {
        throw enhanceFsError(
          err,
          tool.name,
          typeof record?.path === "string" ? String(record.path) : undefined,
        );
      }
    },
  };
}

function wrapSandboxPathGuard(tool: AnyAgentTool, root: string): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      const filePath = record?.path;
      if (typeof filePath === "string" && filePath.trim()) {
        await assertSandboxPath({ filePath, cwd: root, root });
      }
      return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
    },
  };
}

export function createSandboxedReadTool(root: string) {
  const base = createReadTool(root) as unknown as AnyAgentTool;
  return wrapSandboxPathGuard(createOpenClawReadTool(base, { workspaceRoot: root }), root);
}

export function createSandboxedWriteTool(root: string) {
  const base = createWriteTool(root) as unknown as AnyAgentTool;
  return wrapSandboxPathGuard(wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write), root);
}

export function createSandboxedEditTool(root: string) {
  const base = createEditTool(root) as unknown as AnyAgentTool;
  return wrapSandboxPathGuard(wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.edit), root);
}

async function resolveReadSnapshot(
  filePath: string,
  workspaceRoot?: string,
): Promise<{
  snapshot?: {
    path: string;
    resolvedPath: string;
    sizeBytes: number;
    mtimeMs: number;
    snapshotKey: string;
  };
  diagnostic?: {
    code: string;
    message: string;
  };
}> {
  const resolvedPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(workspaceRoot ?? process.cwd(), filePath);
  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      return {
        diagnostic: {
          code: "read_snapshot_unavailable",
          message: `read: snapshot unavailable because path is not a file (${filePath})`,
        },
      };
    }
    const snapshotKey = crypto
      .createHash("sha256")
      .update(resolvedPath)
      .update("|")
      .update(String(stat.size))
      .update("|")
      .update(String(stat.mtimeMs))
      .digest("hex")
      .slice(0, 16);
    return {
      snapshot: {
        path: filePath,
        resolvedPath,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        snapshotKey,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      diagnostic: {
        code: "read_snapshot_unavailable",
        message: `read: snapshot unavailable (${filePath}): ${message}`,
      },
    };
  }
}

export function createOpenClawReadTool(
  base: AnyAgentTool,
  opts?: { workspaceRoot?: string },
): AnyAgentTool {
  const patched = patchToolSchemaForClaudeCompatibility(base);
  return {
    ...patched,
    execute: async (toolCallId, params, signal) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);

      try {
        assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);
        const result = await base.execute(toolCallId, normalized ?? params, signal);
        const filePath = typeof record?.path === "string" ? String(record.path) : "<unknown>";
        const diagnostics: Array<{ code: string; message: string }> = [];
        const normalizedRead = await normalizeReadImageResult(result, filePath);
        diagnostics.push(...normalizedRead.diagnostics);
        const sanitized = await sanitizeToolResultImages(
          normalizedRead.result,
          `read:${filePath}`,
          {
            diagnostics,
          },
        );
        const snapshotRes = await resolveReadSnapshot(filePath, opts?.workspaceRoot);
        if (snapshotRes?.diagnostic) {
          diagnostics.push(snapshotRes.diagnostic);
        }
        const snapshot = snapshotRes?.snapshot;
        const details =
          sanitized &&
          typeof sanitized === "object" &&
          typeof (sanitized as { details?: unknown }).details === "object"
            ? ({ ...(sanitized as { details: Record<string, unknown> }).details } as Record<
                string,
                unknown
              >)
            : {};
        const nextDetails: Record<string, unknown> = {
          ...details,
        };
        if (snapshot) {
          nextDetails.readSnapshot = snapshot;
        }
        if (diagnostics.length > 0) {
          nextDetails.readDiagnostics = diagnostics;
        }
        return {
          ...sanitized,
          details: nextDetails,
        };
      } catch (err) {
        throw enhanceFsError(
          err,
          base.name,
          typeof record?.path === "string" ? record.path : undefined,
        );
      }
    },
  };
}
