import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyUpdateHunk } from "./apply-patch-update.js";
import { assertSandboxPath } from "./sandbox-paths.js";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

type AddFileHunk = {
  kind: "add";
  path: string;
  contents: string;
};

type DeleteFileHunk = {
  kind: "delete";
  path: string;
};

type UpdateFileChunk = {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
};

type UpdateFileHunk = {
  kind: "update";
  path: string;
  movePath?: string;
  chunks: UpdateFileChunk[];
};

type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

export type ApplyPatchSummary = {
  added: string[];
  modified: string[];
  deleted: string[];
};

export type ApplyPatchResult = {
  summary: ApplyPatchSummary;
  text: string;
};

export type ApplyPatchToolDetails = {
  summary: ApplyPatchSummary;
};

type ApplyPatchOptions = {
  cwd: string;
  workspaceRoot?: string;
  sandboxRoot?: string;
  signal?: AbortSignal;
};

const applyPatchSchema = Type.Object({
  input: Type.String({
    description: "Patch content using the *** Begin Patch/End Patch format.",
  }),
});

export function createApplyPatchTool(
  options: { cwd?: string; workspaceRoot?: string; sandboxRoot?: string } = {},
  // oxlint-disable-next-line typescript/no-explicit-any
): AgentTool<any, ApplyPatchToolDetails> {
  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = options.workspaceRoot;
  const sandboxRoot = options.sandboxRoot;

  return {
    name: "apply_patch",
    label: "apply_patch",
    description:
      "Apply a patch to one or more files using the apply_patch format. The input should include *** Begin Patch and *** End Patch markers.",
    parameters: applyPatchSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as { input?: string };
      const input = typeof params.input === "string" ? params.input : "";
      if (!input.trim()) {
        throw new Error("Provide a patch input.");
      }
      if (signal?.aborted) {
        const err = new Error("Aborted");
        err.name = "AbortError";
        throw err;
      }

      const result = await applyPatch(input, {
        cwd,
        workspaceRoot,
        sandboxRoot,
        signal,
      });

      return {
        content: [{ type: "text", text: result.text }],
        details: { summary: result.summary },
      };
    },
  };
}

const MAX_PATCH_HUNKS = 20;

export async function applyPatch(
  input: string,
  options: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
  const parsed = parsePatchText(input);
  if (parsed.hunks.length === 0) {
    throw new Error("No files were modified.");
  }
  if (parsed.hunks.length > MAX_PATCH_HUNKS) {
    throw new Error(
      `Patch contains ${parsed.hunks.length} hunks which exceeds maximum of ${MAX_PATCH_HUNKS}. Split into smaller patches.`,
    );
  }

  // ── Phase 1: Pre-flight validation (read + validate, no writes) ──────────
  // Resolves all paths, reads all files needed for updates, and validates
  // all hunk context matches. If ANY hunk fails validation, NO files are
  // modified. Cached content is reused in the apply phase (TOCTOU defense).

  type ValidatedHunk =
    | { kind: "add"; resolved: string; display: string; contents: string }
    | { kind: "delete"; resolved: string; display: string }
    | {
        kind: "update";
        resolved: string;
        display: string;
        applied: string;
        movePath?: { resolved: string; display: string };
      };

  const validated: ValidatedHunk[] = [];

  for (const hunk of parsed.hunks) {
    if (options.signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    if (hunk.kind === "add") {
      const target = await resolvePatchPath(hunk.path, options);
      validated.push({
        kind: "add",
        resolved: target.resolved,
        display: target.display,
        contents: hunk.contents,
      });
      continue;
    }

    if (hunk.kind === "delete") {
      const target = await resolvePatchPath(hunk.path, options);
      // Validate the file exists before committing to the apply phase
      await fs.stat(target.resolved);
      validated.push({
        kind: "delete",
        resolved: target.resolved,
        display: target.display,
      });
      continue;
    }

    // Update: read file, validate context, cache the applied result
    const target = await resolvePatchPath(hunk.path, options);
    const content = await fs.readFile(target.resolved, "utf8").catch((err) => {
      throw new Error(`Failed to read file to update ${target.resolved}: ${err}`);
    });
    // Use cached content (not re-read) — TOCTOU defense
    const applied = await applyUpdateHunk(target.resolved, hunk.chunks, content);

    let movePath: { resolved: string; display: string } | undefined;
    if (hunk.movePath) {
      movePath = await resolvePatchPath(hunk.movePath, options);
    }

    validated.push({
      kind: "update",
      resolved: target.resolved,
      display: target.display,
      applied,
      movePath,
    });
  }

  // ── Phase 2: Apply (write only — all validation already passed) ─────────

  const summary: ApplyPatchSummary = {
    added: [],
    modified: [],
    deleted: [],
  };
  const seen = {
    added: new Set<string>(),
    modified: new Set<string>(),
    deleted: new Set<string>(),
  };

  for (const v of validated) {
    if (options.signal?.aborted) {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    }

    if (v.kind === "add") {
      await ensureDir(v.resolved);
      await fs.writeFile(v.resolved, v.contents, "utf8");
      recordSummary(summary, seen, "added", v.display);
      continue;
    }

    if (v.kind === "delete") {
      await fs.rm(v.resolved);
      recordSummary(summary, seen, "deleted", v.display);
      continue;
    }

    if (v.movePath) {
      await ensureDir(v.movePath.resolved);
      await fs.writeFile(v.movePath.resolved, v.applied, "utf8");
      await fs.rm(v.resolved);
      recordSummary(summary, seen, "modified", v.movePath.display);
    } else {
      await fs.writeFile(v.resolved, v.applied, "utf8");
      recordSummary(summary, seen, "modified", v.display);
    }
  }

  return {
    summary,
    text: formatSummary(summary),
  };
}

function recordSummary(
  summary: ApplyPatchSummary,
  seen: {
    added: Set<string>;
    modified: Set<string>;
    deleted: Set<string>;
  },
  bucket: keyof ApplyPatchSummary,
  value: string,
) {
  if (seen[bucket].has(value)) {
    return;
  }
  seen[bucket].add(value);
  summary[bucket].push(value);
}

function formatSummary(summary: ApplyPatchSummary): string {
  const lines = ["Success. Updated the following files:"];
  for (const file of summary.added) {
    lines.push(`A ${file}`);
  }
  for (const file of summary.modified) {
    lines.push(`M ${file}`);
  }
  for (const file of summary.deleted) {
    lines.push(`D ${file}`);
  }
  return lines.join("\n");
}

async function ensureDir(filePath: string) {
  const parent = path.dirname(filePath);
  if (!parent || parent === ".") {
    return;
  }
  await fs.mkdir(parent, { recursive: true });
}

async function resolvePatchPath(
  filePath: string,
  options: ApplyPatchOptions,
): Promise<{ resolved: string; display: string }> {
  if (options.sandboxRoot) {
    const resolved = await assertSandboxPath({
      filePath,
      cwd: options.cwd,
      root: options.sandboxRoot,
    });
    return {
      resolved: resolved.resolved,
      display: resolved.relative || resolved.resolved,
    };
  }

  const resolved = resolvePathFromCwd(filePath, options.cwd);

  if (options.workspaceRoot) {
    await assertWorkspacePath(resolved, options.workspaceRoot);
  }

  return {
    resolved,
    display: toDisplayPath(resolved, options.cwd),
  };
}

async function assertWorkspacePath(resolved: string, workspaceRoot: string): Promise<void> {
  const normalizedRoot = path.resolve(workspaceRoot) + path.sep;
  const normalizedResolved = path.resolve(resolved);

  // Lexical check: resolved path must start with workspace root
  if (
    !normalizedResolved.startsWith(normalizedRoot) &&
    normalizedResolved !== path.resolve(workspaceRoot)
  ) {
    throw new Error(`Path "${resolved}" escapes workspace root "${workspaceRoot}".`);
  }

  // Physical check: resolve symlinks and verify the real path is still inside workspace
  try {
    // Walk up from the resolved path to find the deepest existing ancestor
    let checkPath = normalizedResolved;
    while (checkPath !== path.dirname(checkPath)) {
      try {
        const realPath = await fs.realpath(checkPath);
        const realRoot = await fs.realpath(workspaceRoot);
        const realRootPrefix = realRoot + path.sep;
        if (!realPath.startsWith(realRootPrefix) && realPath !== realRoot) {
          throw new Error(
            `Path "${resolved}" resolves outside workspace root (symlink). Real path: "${realPath}".`,
          );
        }
        return; // Passed both checks
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // Path doesn't exist yet (e.g., Add File), walk up to parent
          checkPath = path.dirname(checkPath);
          continue;
        }
        throw err; // Re-throw non-ENOENT errors (including our own workspace errors)
      }
    }
  } catch (err) {
    if ((err as Error).message.includes("resolves outside workspace root")) {
      throw err;
    }
    // If we can't resolve symlinks at all (e.g., workspace root doesn't exist),
    // the lexical check already passed, so allow it
  }
}

function normalizeUnicodeSpaces(value: string): string {
  return value.replace(UNICODE_SPACES, " ");
}

function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(filePath);
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

function resolvePathFromCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.resolve(cwd, expanded);
}

function toDisplayPath(resolved: string, cwd: string): string {
  const relative = path.relative(cwd, resolved);
  if (!relative || relative === "") {
    return path.basename(resolved);
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return resolved;
  }
  return relative;
}

function parsePatchText(input: string): { hunks: Hunk[]; patch: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Invalid patch: input is empty.");
  }

  const lines = trimmed.split(/\r?\n/);
  const validated = checkPatchBoundariesLenient(lines);
  const hunks: Hunk[] = [];

  const lastLineIndex = validated.length - 1;
  let remaining = validated.slice(1, lastLineIndex);
  let lineNumber = 2;

  while (remaining.length > 0) {
    const { hunk, consumed } = parseOneHunk(remaining, lineNumber);
    hunks.push(hunk);
    lineNumber += consumed;
    remaining = remaining.slice(consumed);
  }

  return { hunks, patch: validated.join("\n") };
}

function checkPatchBoundariesLenient(lines: string[]): string[] {
  const strictError = checkPatchBoundariesStrict(lines);
  if (!strictError) {
    return lines;
  }

  if (lines.length < 4) {
    throw new Error(strictError);
  }
  const first = lines[0];
  const last = lines[lines.length - 1];
  if ((first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') && last.endsWith("EOF")) {
    const inner = lines.slice(1, lines.length - 1);
    const innerError = checkPatchBoundariesStrict(inner);
    if (!innerError) {
      return inner;
    }
    throw new Error(innerError);
  }

  throw new Error(strictError);
}

function checkPatchBoundariesStrict(lines: string[]): string | null {
  const firstLine = lines[0]?.trim();
  const lastLine = lines[lines.length - 1]?.trim();

  if (firstLine === BEGIN_PATCH_MARKER && lastLine === END_PATCH_MARKER) {
    return null;
  }
  if (firstLine !== BEGIN_PATCH_MARKER) {
    return "The first line of the patch must be '*** Begin Patch'";
  }
  return "The last line of the patch must be '*** End Patch'";
}

function parseOneHunk(lines: string[], lineNumber: number): { hunk: Hunk; consumed: number } {
  if (lines.length === 0) {
    throw new Error(`Invalid patch hunk at line ${lineNumber}: empty hunk`);
  }
  const firstLine = lines[0].trim();
  if (firstLine.startsWith(ADD_FILE_MARKER)) {
    const targetPath = firstLine.slice(ADD_FILE_MARKER.length);
    let contents = "";
    let consumed = 1;
    for (const addLine of lines.slice(1)) {
      if (addLine.startsWith("+")) {
        contents += `${addLine.slice(1)}\n`;
        consumed += 1;
      } else {
        break;
      }
    }
    return {
      hunk: { kind: "add", path: targetPath, contents },
      consumed,
    };
  }

  if (firstLine.startsWith(DELETE_FILE_MARKER)) {
    const targetPath = firstLine.slice(DELETE_FILE_MARKER.length);
    return {
      hunk: { kind: "delete", path: targetPath },
      consumed: 1,
    };
  }

  if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
    const targetPath = firstLine.slice(UPDATE_FILE_MARKER.length);
    let remaining = lines.slice(1);
    let consumed = 1;
    let movePath: string | undefined;

    const moveCandidate = remaining[0]?.trim();
    if (moveCandidate?.startsWith(MOVE_TO_MARKER)) {
      movePath = moveCandidate.slice(MOVE_TO_MARKER.length);
      remaining = remaining.slice(1);
      consumed += 1;
    }

    const chunks: UpdateFileChunk[] = [];
    while (remaining.length > 0) {
      if (remaining[0].trim() === "") {
        remaining = remaining.slice(1);
        consumed += 1;
        continue;
      }
      if (remaining[0].startsWith("***")) {
        break;
      }
      const { chunk, consumed: chunkLines } = parseUpdateFileChunk(
        remaining,
        lineNumber + consumed,
        chunks.length === 0,
      );
      chunks.push(chunk);
      remaining = remaining.slice(chunkLines);
      consumed += chunkLines;
    }

    if (chunks.length === 0) {
      throw new Error(
        `Invalid patch hunk at line ${lineNumber}: Update file hunk for path '${targetPath}' is empty`,
      );
    }

    return {
      hunk: {
        kind: "update",
        path: targetPath,
        movePath,
        chunks,
      },
      consumed,
    };
  }

  throw new Error(
    `Invalid patch hunk at line ${lineNumber}: '${lines[0]}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
  );
}

function parseUpdateFileChunk(
  lines: string[],
  lineNumber: number,
  allowMissingContext: boolean,
): { chunk: UpdateFileChunk; consumed: number } {
  if (lines.length === 0) {
    throw new Error(
      `Invalid patch hunk at line ${lineNumber}: Update hunk does not contain any lines`,
    );
  }

  let changeContext: string | undefined;
  let startIndex = 0;
  if (lines[0] === EMPTY_CHANGE_CONTEXT_MARKER) {
    startIndex = 1;
  } else if (lines[0].startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = lines[0].slice(CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else if (!allowMissingContext) {
    throw new Error(
      `Invalid patch hunk at line ${lineNumber}: Expected update hunk to start with a @@ context marker, got: '${lines[0]}'`,
    );
  }

  if (startIndex >= lines.length) {
    throw new Error(
      `Invalid patch hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`,
    );
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  };

  let parsedLines = 0;
  for (const line of lines.slice(startIndex)) {
    if (line === EOF_MARKER) {
      if (parsedLines === 0) {
        throw new Error(
          `Invalid patch hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`,
        );
      }
      chunk.isEndOfFile = true;
      parsedLines += 1;
      break;
    }

    const marker = line[0];
    if (!marker) {
      chunk.oldLines.push("");
      chunk.newLines.push("");
      parsedLines += 1;
      continue;
    }

    if (marker === " ") {
      const content = line.slice(1);
      chunk.oldLines.push(content);
      chunk.newLines.push(content);
      parsedLines += 1;
      continue;
    }
    if (marker === "+") {
      chunk.newLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }
    if (marker === "-") {
      chunk.oldLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }

    if (parsedLines === 0) {
      throw new Error(
        `Invalid patch hunk at line ${lineNumber + 1}: Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      );
    }
    break;
  }

  return { chunk, consumed: parsedLines + startIndex };
}
