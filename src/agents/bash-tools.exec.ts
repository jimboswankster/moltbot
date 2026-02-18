import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import {
  type ExecAsk,
  type ExecHost,
  type ExecSecurity,
  type ExecApprovalsFile,
  addAllowlistEntry,
  evaluateShellAllowlist,
  maxAsk,
  minSecurity,
  requiresExecApproval,
  resolveSafeBins,
  recordAllowlistUse,
  resolveExecApprovals,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { logInfo, logWarn } from "../logger.js";
import { formatSpawnError, spawnWithFallback } from "../process/spawn-utils.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  type ProcessSession,
  type SessionStdin,
  addSession,
  appendOutput,
  createSessionSlug,
  markBackgrounded,
  markExited,
  tail,
} from "./bash-process-registry.js";
import {
  buildDockerExecArgs,
  buildSandboxEnv,
  chunkString,
  clampNumber,
  coerceEnv,
  killSession,
  readEnvInt,
  resolveSandboxWorkdir,
  resolveWorkdir,
  truncateMiddle,
} from "./bash-tools.shared.js";
import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";
import { getShellConfig, sanitizeBinaryOutput } from "./shell-utils.js";
import { callGatewayTool } from "./tools/gateway.js";
import { listNodes, resolveNodeIdFromList } from "./tools/nodes-utils.js";

// Security: Blocklist of environment variables that could alter execution flow
// or inject code when running on non-sandboxed hosts (Gateway/Node).
const DANGEROUS_HOST_ENV_VARS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYLIB",
  "PERL5LIB",
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
  "IFS",
  "SSLKEYLOGFILE",
]);
const DANGEROUS_HOST_ENV_PREFIXES = ["DYLD_", "LD_"];

// Centralized sanitization helper.
// Throws an error if dangerous variables or PATH modifications are detected on the host.
function validateHostEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();

    // 1. Block known dangerous variables (Fail Closed)
    if (DANGEROUS_HOST_ENV_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
      throw new Error(
        `Security Violation: Environment variable '${key}' is forbidden during host execution.`,
      );
    }
    if (DANGEROUS_HOST_ENV_VARS.has(upperKey)) {
      throw new Error(
        `Security Violation: Environment variable '${key}' is forbidden during host execution.`,
      );
    }

    // 2. Strictly block PATH modification on host
    // Allowing custom PATH on the gateway/node can lead to binary hijacking.
    if (upperKey === "PATH") {
      throw new Error(
        "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
      );
    }
  }
}
const DEFAULT_MAX_OUTPUT = clampNumber(
  readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);
const DEFAULT_PENDING_MAX_OUTPUT = clampNumber(
  readEnvInt("OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);
const DEFAULT_PATH =
  process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_NOTIFY_TAIL_CHARS = 400;
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = 130_000;
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10_000;
const APPROVAL_SLUG_LENGTH = 8;
const REPAIRABLE_SIMPLE_EXEC_COMMANDS = new Set(["ls", "stat", "cat", "cp", "file"]);
const QUOTED_ABSOLUTE_PATH_PATTERN = /(["'])(\/[^"'\n]+)\1/g;
const SHELL_COMPLEXITY_PATTERN = /(?:&&|\|\||[|;`<>]|\$\(|\n)/;
const HEAVY_AUTO_BACKGROUND_BINS = new Set([
  "pnpm",
  "npm",
  "yarn",
  "bun",
  "npx",
  "uv",
  "pip",
  "pip3",
  "poetry",
  "cargo",
  "go",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "pytest",
  "vitest",
  "jest",
  "tsc",
  "vite",
  "webpack",
  "rollup",
  "docker",
]);
const HEAVY_AUTO_BACKGROUND_KEYWORD_PATTERN =
  /\b(install|build|test|typecheck|compile|check|audit|upgrade|migrate|sync)\b/i;
const EXEC_RETRY_BRAKE_WINDOW_MS = 10 * 60 * 1000;
const EXEC_RETRY_BRAKE_COOLDOWN_MS = 5 * 60 * 1000;
const EXEC_RETRY_BRAKE_THRESHOLD = 2;
const EXEC_POLICY_MODE_VALUES = new Set(["off", "shadow", "enforce"]);

type RetryBrakeFailureClass = "resource_kill" | "timeout" | "path_missing";
type ExecPolicyMode = "off" | "shadow" | "enforce";
type RetryBrakeEntry = {
  failureClass: RetryBrakeFailureClass;
  consecutive: number;
  lastFailureAt: number;
  cooldownUntilMs: number;
  sampleReason?: string;
};

const execRetryBrake = new Map<string, RetryBrakeEntry>();

function resolveExecPolicyMode(
  preferred: ExecPolicyMode | undefined,
  envKey: string,
  fallback: ExecPolicyMode,
): ExecPolicyMode {
  if (preferred && EXEC_POLICY_MODE_VALUES.has(preferred)) {
    return preferred;
  }
  const raw = process.env[envKey]?.trim().toLowerCase();
  if (raw && EXEC_POLICY_MODE_VALUES.has(raw)) {
    return raw as ExecPolicyMode;
  }
  return fallback;
}

type PtyExitEvent = { exitCode: number; signal?: number };
type PtyListener<T> = (event: T) => void;
type PtyHandle = {
  pid: number;
  write: (data: string | Buffer) => void;
  onData: (listener: PtyListener<string>) => void;
  onExit: (listener: PtyListener<PtyExitEvent>) => void;
};
type PtySpawn = (
  file: string,
  args: string[] | string,
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
  },
) => PtyHandle;

type ExecProcessOutcome = {
  status: "completed" | "failed";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  aggregated: string;
  timedOut: boolean;
  reason?: string;
};

type ExecPolicyDiagnostics = {
  autoBackground: {
    mode: ExecPolicyMode;
    heavyCandidate: boolean;
    wouldBackground: boolean;
    applied: boolean;
  };
  retryBrake: {
    mode: ExecPolicyMode;
    blocked: boolean;
    enforced: boolean;
    waitMs: number;
    failureClass?: RetryBrakeFailureClass;
  };
};

type PathRepairDecision = "rewrite" | "block" | "no-op";

type PathRepairParityDecision = {
  decision: PathRepairDecision;
  blocked: boolean;
  reason?: string;
};

type ExecProcessHandle = {
  session: ProcessSession;
  startedAt: number;
  pid?: number;
  promise: Promise<ExecProcessOutcome>;
  kill: () => void;
};

export type ExecToolDefaults = {
  host?: ExecHost;
  security?: ExecSecurity;
  ask?: ExecAsk;
  node?: string;
  pathPrepend?: string[];
  safeBins?: string[];
  agentId?: string;
  backgroundMs?: number;
  timeoutSec?: number;
  approvalRunningNoticeMs?: number;
  sandbox?: BashSandboxConfig;
  elevated?: ExecElevatedDefaults;
  allowBackground?: boolean;
  scopeKey?: string;
  sessionKey?: string;
  messageProvider?: string;
  notifyOnExit?: boolean;
  cwd?: string;
  /** Default memory limit (MB) for spawned processes. 0 = disabled. */
  memoryLimitMB?: number;
  autoBackgroundMode?: ExecPolicyMode;
  retryBrakeMode?: ExecPolicyMode;
};

export type { BashSandboxConfig } from "./bash-tools.shared.js";

export type ExecElevatedDefaults = {
  enabled: boolean;
  allowed: boolean;
  defaultLevel: "on" | "off" | "ask" | "full";
};

const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description:
        "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Run on the host with elevated permissions (if allowed)",
    }),
  ),
  host: Type.Optional(
    Type.String({
      description: "Exec host (sandbox|gateway|node).",
    }),
  ),
  security: Type.Optional(
    Type.String({
      description: "Exec security mode (deny|allowlist|full).",
    }),
  ),
  ask: Type.Optional(
    Type.String({
      description: "Exec ask mode (off|on-miss|always).",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description: "Node id/name for host=node.",
    }),
  ),
  memoryLimitMB: Type.Optional(
    Type.Number({
      description:
        "Override the default memory limit (MB) for this command. " +
        "The OS kills the process if it exceeds this limit. " +
        "Use for intentional heavy workloads (e.g., large builds, stress tests). " +
        "Set to 0 to disable the limit. Default: use system config.",
      minimum: 0,
    }),
  ),
});

export type ExecToolDetails =
  | {
      status: "running";
      sessionId: string;
      pid?: number;
      startedAt: number;
      cwd?: string;
      tail?: string;
      policy?: ExecPolicyDiagnostics;
    }
  | {
      status: "completed" | "failed";
      exitCode: number | null;
      durationMs: number;
      aggregated: string;
      cwd?: string;
      policy?: ExecPolicyDiagnostics;
    }
  | {
      status: "approval-pending";
      approvalId: string;
      approvalSlug: string;
      expiresAtMs: number;
      host: ExecHost;
      command: string;
      cwd?: string;
      nodeId?: string;
      policy?: ExecPolicyDiagnostics;
    };

function normalizeExecHost(value?: string | null): ExecHost | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "sandbox" || normalized === "gateway" || normalized === "node") {
    return normalized;
  }
  return null;
}

function normalizeExecSecurity(value?: string | null): ExecSecurity | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "deny" || normalized === "allowlist" || normalized === "full") {
    return normalized;
  }
  return null;
}

function normalizeExecAsk(value?: string | null): ExecAsk | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "off" || normalized === "on-miss" || normalized === "always") {
    return normalized as ExecAsk;
  }
  return null;
}

function renderExecHostLabel(host: ExecHost) {
  return host === "sandbox" ? "sandbox" : host === "gateway" ? "gateway" : "node";
}

function normalizeNotifyOutput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePathPrepend(entries?: string[]) {
  if (!Array.isArray(entries)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function mergePathPrepend(existing: string | undefined, prepend: string[]) {
  if (prepend.length === 0) {
    return existing;
  }
  const partsExisting = (existing ?? "")
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const part of [...prepend, ...partsExisting]) {
    if (seen.has(part)) {
      continue;
    }
    seen.add(part);
    merged.push(part);
  }
  return merged.join(path.delimiter);
}

function applyPathPrepend(
  env: Record<string, string>,
  prepend: string[],
  options?: { requireExisting?: boolean },
) {
  if (prepend.length === 0) {
    return;
  }
  if (options?.requireExisting && !env.PATH) {
    return;
  }
  const merged = mergePathPrepend(env.PATH, prepend);
  if (merged) {
    env.PATH = merged;
  }
}

function applyShellPath(env: Record<string, string>, shellPath?: string | null) {
  if (!shellPath) {
    return;
  }
  const entries = shellPath
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return;
  }
  const merged = mergePathPrepend(env.PATH, entries);
  if (merged) {
    env.PATH = merged;
  }
}

type QuotedAbsolutePathMatch = {
  quote: '"' | "'";
  path: string;
  start: number;
  end: number;
};

type ExecCommandRepair = {
  command: string;
  warnings: string[];
};

function normalizeFilenameSpaces(value: string): string {
  // Normalize common Unicode space variants to ASCII space for filename matching.
  return value.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g, " ");
}

function parseLeadingToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const token = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  if (!token) {
    return null;
  }
  return path.basename(token).toLowerCase();
}

function isComplexShellCommand(command: string): boolean {
  return SHELL_COMPLEXITY_PATTERN.test(command);
}

function isLikelyHeavyExecCommand(command: string): boolean {
  const verb = parseLeadingToken(command);
  const normalized = command.trim();
  if (!verb || !normalized) return false;
  if (HEAVY_AUTO_BACKGROUND_BINS.has(verb)) {
    return true;
  }
  if (
    (verb === "bash" || verb === "zsh" || verb === "sh") &&
    HEAVY_AUTO_BACKGROUND_KEYWORD_PATTERN.test(normalized)
  ) {
    return true;
  }
  if (HEAVY_AUTO_BACKGROUND_KEYWORD_PATTERN.test(normalized) && normalized.length >= 180) {
    return true;
  }
  if (normalized.length >= 1200 && isComplexShellCommand(normalized)) {
    return true;
  }
  return false;
}

function normalizeCommandFingerprint(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 512);
}

function classifyRetryBrakeFailure(reason: string | undefined): RetryBrakeFailureClass | null {
  if (!reason) return null;
  const text = reason.toLowerCase();
  if (text.includes("timed out")) return "timeout";
  if (text.includes("sigkill") || text.includes("killed by signal") || text.includes("code 137")) {
    return "resource_kill";
  }
  if (text.includes("path not found:") || text.includes("no such file or directory")) {
    return "path_missing";
  }
  return null;
}

function checkExecRetryBrake(
  command: string,
  nowMs = Date.now(),
): {
  blocked: boolean;
  waitMs: number;
  failureClass?: RetryBrakeFailureClass;
  sampleReason?: string;
} {
  const key = normalizeCommandFingerprint(command);
  if (!key) return { blocked: false, waitMs: 0 };
  const entry = execRetryBrake.get(key);
  if (!entry) return { blocked: false, waitMs: 0 };
  if (entry.cooldownUntilMs <= nowMs) {
    if (nowMs - entry.lastFailureAt > EXEC_RETRY_BRAKE_WINDOW_MS) {
      execRetryBrake.delete(key);
    }
    return { blocked: false, waitMs: 0 };
  }
  return {
    blocked: true,
    waitMs: entry.cooldownUntilMs - nowMs,
    failureClass: entry.failureClass,
    sampleReason: entry.sampleReason,
  };
}

function recordExecRetryBrakeFailure(
  command: string,
  reason: string | undefined,
  nowMs = Date.now(),
): void {
  const failureClass = classifyRetryBrakeFailure(reason);
  if (!failureClass) return;
  const key = normalizeCommandFingerprint(command);
  if (!key) return;
  const previous = execRetryBrake.get(key);
  const withinWindow =
    previous &&
    previous.failureClass === failureClass &&
    nowMs - previous.lastFailureAt <= EXEC_RETRY_BRAKE_WINDOW_MS;
  const consecutive = withinWindow ? previous.consecutive + 1 : 1;
  const cooldownUntilMs =
    consecutive >= EXEC_RETRY_BRAKE_THRESHOLD ? nowMs + EXEC_RETRY_BRAKE_COOLDOWN_MS : 0;
  execRetryBrake.set(key, {
    failureClass,
    consecutive,
    lastFailureAt: nowMs,
    cooldownUntilMs,
    sampleReason: reason,
  });
}

function clearExecRetryBrake(command: string): void {
  const key = normalizeCommandFingerprint(command);
  if (!key) return;
  execRetryBrake.delete(key);
}

export function resetExecRetryBrakeForTests(): void {
  execRetryBrake.clear();
}

function collectQuotedAbsolutePathMatches(command: string): QuotedAbsolutePathMatch[] {
  const matches: QuotedAbsolutePathMatch[] = [];
  let match: RegExpExecArray | null = null;
  QUOTED_ABSOLUTE_PATH_PATTERN.lastIndex = 0;
  while ((match = QUOTED_ABSOLUTE_PATH_PATTERN.exec(command)) !== null) {
    const full = match[0];
    const quote = match[1] === '"' ? '"' : "'";
    const capturedPath = match[2];
    if (!capturedPath) {
      continue;
    }
    matches.push({
      quote,
      path: capturedPath,
      start: match.index,
      end: match.index + full.length,
    });
  }
  return matches;
}

function collectQuotedAbsolutePathMatchesStrict(command: string): {
  matches: QuotedAbsolutePathMatch[];
  parseError: boolean;
} {
  const matches: QuotedAbsolutePathMatch[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if ((ch === '"' || ch === "'") && command[i - 1] !== "\\") {
      const quote = ch as '"' | "'";
      const start = i;
      i += 1;
      const pathStart = i;
      let closed = false;
      while (i < command.length) {
        const cur = command[i];
        if (cur === quote && command[i - 1] !== "\\") {
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        return { matches, parseError: true };
      }
      const capturedPath = command.slice(pathStart, i);
      if (capturedPath.startsWith("/")) {
        matches.push({
          quote,
          path: capturedPath,
          start,
          end: i + 1,
        });
      }
    }
    i += 1;
  }
  return { matches, parseError: false };
}

function evaluatePathRepairDecisionSync(
  command: string,
  matches: QuotedAbsolutePathMatch[],
): PathRepairParityDecision {
  if (matches.length === 0) {
    return { decision: "no-op", blocked: false, reason: "no_quoted_absolute_paths" };
  }
  const isComplex = isComplexShellCommand(command);
  const verb = parseLeadingToken(command);
  const repairAllowed = Boolean(verb && REPAIRABLE_SIMPLE_EXEC_COMMANDS.has(verb));
  const hasMissingPath = matches.some((entry) => !fs.existsSync(entry.path));
  if (hasMissingPath && isComplex) {
    return { decision: "block", blocked: true, reason: "missing_path_in_complex_command" };
  }
  if (!repairAllowed) {
    return { decision: "no-op", blocked: false, reason: "repair_not_allowed_for_command" };
  }
  let rewroteAny = false;
  for (const match of matches) {
    const resolved = resolveUnicodeSpaceVariantAbsolutePath(match.path);
    if (!resolved) {
      if (!fs.existsSync(match.path)) {
        return { decision: "block", blocked: true, reason: "missing_path_no_unicode_variant" };
      }
      continue;
    }
    if (resolved !== match.path) {
      rewroteAny = true;
    }
  }
  return {
    decision: rewroteAny ? "rewrite" : "no-op",
    blocked: false,
    reason: rewroteAny ? "unicode_path_rewrite" : "no_change",
  };
}

async function pathExistsAsync(pathname: string): Promise<boolean> {
  try {
    await fsPromises.access(pathname, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveUnicodeSpaceVariantAbsolutePathAsync(
  rawPath: string,
): Promise<string | null> {
  if (await pathExistsAsync(rawPath)) {
    return rawPath;
  }
  const dir = path.dirname(rawPath);
  if (!(await pathExistsAsync(dir))) {
    return null;
  }
  let entries: string[];
  try {
    entries = await fsPromises.readdir(dir);
  } catch {
    return null;
  }
  const targetBase = normalizeFilenameSpaces(path.basename(rawPath));
  const matches = entries.filter((entry) => normalizeFilenameSpaces(entry) === targetBase);
  if (matches.length !== 1) {
    return null;
  }
  const candidate = path.join(dir, matches[0]);
  return (await pathExistsAsync(candidate)) ? candidate : null;
}

async function evaluatePathRepairDecisionAsyncFs(
  command: string,
): Promise<PathRepairParityDecision> {
  const matches = collectQuotedAbsolutePathMatches(command);
  if (matches.length === 0) {
    return { decision: "no-op", blocked: false, reason: "no_quoted_absolute_paths" };
  }
  const isComplex = isComplexShellCommand(command);
  const verb = parseLeadingToken(command);
  const repairAllowed = Boolean(verb && REPAIRABLE_SIMPLE_EXEC_COMMANDS.has(verb));
  let hasMissingPath = false;
  for (const entry of matches) {
    if (!(await pathExistsAsync(entry.path))) {
      hasMissingPath = true;
      break;
    }
  }
  if (hasMissingPath && isComplex) {
    return { decision: "block", blocked: true, reason: "missing_path_in_complex_command" };
  }
  if (!repairAllowed) {
    return { decision: "no-op", blocked: false, reason: "repair_not_allowed_for_command" };
  }
  let rewroteAny = false;
  for (const match of matches) {
    const resolved = await resolveUnicodeSpaceVariantAbsolutePathAsync(match.path);
    if (!resolved) {
      if (!(await pathExistsAsync(match.path))) {
        return { decision: "block", blocked: true, reason: "missing_path_no_unicode_variant" };
      }
      continue;
    }
    if (resolved !== match.path) {
      rewroteAny = true;
    }
  }
  return {
    decision: rewroteAny ? "rewrite" : "no-op",
    blocked: false,
    reason: rewroteAny ? "unicode_path_rewrite" : "no_change",
  };
}

function evaluatePathRepairDecisionShadowParser(command: string): PathRepairParityDecision {
  const strict = collectQuotedAbsolutePathMatchesStrict(command);
  if (strict.parseError) {
    return { decision: "block", blocked: true, reason: "strict_parser_unbalanced_quote" };
  }
  return evaluatePathRepairDecisionSync(command, strict.matches);
}

function resolveUnicodeSpaceVariantAbsolutePath(rawPath: string): string | null {
  if (fs.existsSync(rawPath)) {
    return rawPath;
  }
  const dir = path.dirname(rawPath);
  if (!fs.existsSync(dir)) {
    return null;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const targetBase = normalizeFilenameSpaces(path.basename(rawPath));
  const matches = entries.filter((entry) => normalizeFilenameSpaces(entry) === targetBase);
  if (matches.length !== 1) {
    return null;
  }
  const candidate = path.join(dir, matches[0]);
  return fs.existsSync(candidate) ? candidate : null;
}

function buildMissingPathHint(rawPath: string, complex: boolean): string {
  const dir = path.dirname(rawPath);
  const extra = complex
    ? "Complex shell command was not auto-rewritten; run a path check first."
    : "Use the exact filename from disk and retry once.";
  return [
    `Path not found: ${rawPath}`,
    extra,
    `Quick check: ls -lb "${dir}"`,
    "Common failure: filename contains Unicode spaces (for example before AM/PM in screenshots).",
  ].join(" ");
}

function repairExecCommandUnicodeSpacePaths(command: string): ExecCommandRepair {
  const matches = collectQuotedAbsolutePathMatches(command);
  if (matches.length === 0) {
    return { command, warnings: [] };
  }

  const isComplex = isComplexShellCommand(command);
  const verb = parseLeadingToken(command);
  const repairAllowed = Boolean(verb && REPAIRABLE_SIMPLE_EXEC_COMMANDS.has(verb));
  const hasMissingPath = matches.some((entry) => !fs.existsSync(entry.path));

  if (hasMissingPath && isComplex) {
    const missing = matches.find((entry) => !fs.existsSync(entry.path));
    if (missing) {
      throw new Error(buildMissingPathHint(missing.path, true));
    }
  }
  if (!repairAllowed) {
    return { command, warnings: [] };
  }

  const rewrittenParts: string[] = [];
  let cursor = 0;
  let rewroteAny = false;
  const warnings: string[] = [];

  for (const match of matches) {
    rewrittenParts.push(command.slice(cursor, match.start));

    const resolved = resolveUnicodeSpaceVariantAbsolutePath(match.path);
    if (!resolved) {
      if (!fs.existsSync(match.path)) {
        throw new Error(buildMissingPathHint(match.path, false));
      }
      rewrittenParts.push(command.slice(match.start, match.end));
      cursor = match.end;
      continue;
    }

    if (resolved !== match.path) {
      rewroteAny = true;
      warnings.push(
        `Adjusted quoted path for ${verb}: ${match.path} -> ${resolved} (unicode-space filename match).`,
      );
    }
    rewrittenParts.push(`${match.quote}${resolved}${match.quote}`);
    cursor = match.end;
  }

  rewrittenParts.push(command.slice(cursor));
  if (!rewroteAny) {
    return { command, warnings: [] };
  }
  return { command: rewrittenParts.join(""), warnings };
}

function maybeNotifyOnExit(session: ProcessSession, status: "completed" | "failed") {
  if (!session.backgrounded || !session.notifyOnExit || session.exitNotified) {
    return;
  }
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  session.exitNotified = true;
  const exitLabel = session.exitSignal
    ? `signal ${session.exitSignal}`
    : `code ${session.exitCode ?? 0}`;
  const output = normalizeNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  const summary = output
    ? `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${status} (${session.id.slice(0, 8)}, ${exitLabel})`;
  enqueueSystemEvent(summary, { sessionKey });
  requestHeartbeatNow({ reason: `exec:${session.id}:exit` });
}

function createApprovalSlug(id: string) {
  return id.slice(0, APPROVAL_SLUG_LENGTH);
}

function resolveApprovalRunningNoticeMs(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

function emitExecSystemEvent(text: string, opts: { sessionKey?: string; contextKey?: string }) {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  enqueueSystemEvent(text, { sessionKey, contextKey: opts.contextKey });
  requestHeartbeatNow({ reason: "exec-event" });
}

type DeferredExecTelemetryInput = {
  host: ExecHost;
  command: string;
  status: "completed" | "failed";
  rolloutPlane?: string;
  sessionKey?: string;
  agentId?: string;
  approvalId?: string;
  nodeId?: string;
  reason?: string;
  durationMs?: number;
  exitCode?: number | null;
};

type PathRepairParityTelemetryInput = {
  command: string;
  rolloutPlane?: string;
  sessionKey?: string;
  agentId?: string;
  parserPrimaryDecision: PathRepairDecision;
  parserShadowDecision: PathRepairDecision;
  parserPrimaryBlocked: boolean;
  parserShadowBlocked: boolean;
  parserPrimaryReason?: string;
  parserShadowReason?: string;
  asyncFsPrimaryDecision: PathRepairDecision;
  asyncFsShadowDecision: PathRepairDecision;
  asyncFsPrimaryBlocked: boolean;
  asyncFsShadowBlocked: boolean;
  asyncFsPrimaryReason?: string;
  asyncFsShadowReason?: string;
};

function resolveExecRolloutPlane(): string {
  const raw = process.env.OPENCLAW_EXEC_ROLLOUT_PLANE?.trim().toLowerCase();
  if (raw === "primary" || raw === "shadow") {
    return raw;
  }
  return "shadow";
}

function classifyDeferredExecReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const text = reason.toLowerCase();
  if (text.includes("killed by signal sigkill")) return "resource_kill";
  if (text.includes("timed out")) return "timeout";
  if (text.includes("blocked:")) return "policy_block";
  if (text.includes("command exited with code")) return "nonzero_exit";
  if (text.includes("no such file or directory")) return "path_missing";
  if (text.includes("sandbox")) return "sandbox_error";
  return "other_exec";
}

function resolveDeferredTelemetryPath(): string | null {
  const explicitPath = process.env.OPENCLAW_TOOL_TELEMETRY_EVENTS_PATH?.trim();
  if (explicitPath) {
    return explicitPath;
  }
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR?.trim();
  if (!workspaceDir) {
    return null;
  }
  const day = new Date().toISOString().slice(0, 10);
  return path.join(
    workspaceDir,
    "os",
    "audits",
    "tool-telemetry",
    "events",
    `tool-telemetry-${day}.jsonl`,
  );
}

function emitDeferredExecTelemetry(input: DeferredExecTelemetryInput): void {
  const outPath = resolveDeferredTelemetryPath();
  if (!outPath) {
    return;
  }
  const record = {
    ts: new Date().toISOString(),
    hook: "exec_deferred_outcome",
    toolName: "exec",
    host: input.host,
    rolloutPlane: input.rolloutPlane ?? resolveExecRolloutPlane(),
    status: input.status,
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    approvalId: input.approvalId,
    nodeId: input.nodeId,
    commandChars: input.command.length,
    commandPreview: truncateMiddle(input.command, 240),
    reason: input.reason,
    errorClass: classifyDeferredExecReason(input.reason),
    durationMs: input.durationMs ?? null,
    exitCode: typeof input.exitCode === "number" ? input.exitCode : null,
  };
  void fsPromises
    .mkdir(path.dirname(outPath), { recursive: true })
    .then(() => fsPromises.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8"))
    .catch((err) => {
      logWarn(`exec: deferred telemetry write failed (${String(err)})`);
    });
}

function emitExecPathRepairParityTelemetry(input: PathRepairParityTelemetryInput): void {
  const outPath = resolveDeferredTelemetryPath();
  if (!outPath) {
    return;
  }
  const record = {
    ts: new Date().toISOString(),
    hook: "exec_path_repair_parity",
    toolName: "exec",
    rolloutPlane: input.rolloutPlane ?? resolveExecRolloutPlane(),
    sessionKey: input.sessionKey,
    agentId: input.agentId,
    commandChars: input.command.length,
    commandPreview: truncateMiddle(input.command, 240),
    parserPrimaryDecision: input.parserPrimaryDecision,
    parserShadowDecision: input.parserShadowDecision,
    parserPrimaryBlocked: input.parserPrimaryBlocked,
    parserShadowBlocked: input.parserShadowBlocked,
    parserPrimaryReason: input.parserPrimaryReason,
    parserShadowReason: input.parserShadowReason,
    asyncFsPrimaryDecision: input.asyncFsPrimaryDecision,
    asyncFsShadowDecision: input.asyncFsShadowDecision,
    asyncFsPrimaryBlocked: input.asyncFsPrimaryBlocked,
    asyncFsShadowBlocked: input.asyncFsShadowBlocked,
    asyncFsPrimaryReason: input.asyncFsPrimaryReason,
    asyncFsShadowReason: input.asyncFsShadowReason,
  };
  void fsPromises
    .mkdir(path.dirname(outPath), { recursive: true })
    .then(() => fsPromises.appendFile(outPath, `${JSON.stringify(record)}\n`, "utf8"))
    .catch((err) => {
      logWarn(`exec: path-repair parity telemetry write failed (${String(err)})`);
    });
}

/**
 * Wrap a shell command with `ulimit -v <KB>` to cap virtual memory.
 * When the child process exceeds the limit, the OS kills it (SIGKILL on
 * allocation failure).  The agent receives a clear error with the limit.
 *
 * On macOS, `ulimit -v` restricts the virtual address space and is enforced
 * by the kernel.  On Linux, it maps to RLIMIT_AS with the same effect.
 *
 * @param command  Original shell command.
 * @param limitMB  Memory limit in megabytes. 0 or undefined = no limit.
 * @returns The command string, potentially prefixed with `ulimit -v`.
 */
export function wrapWithMemoryLimit(command: string, limitMB: number | undefined): string {
  if (!limitMB || limitMB <= 0) return command;
  const limitKB = limitMB * 1024;
  // Use subshell so ulimit only affects the child, not the parent shell.
  return `ulimit -v ${limitKB} 2>/dev/null; ${command}`;
}

function applyShellCompatPrefixes(command: string, shellPath: string): string {
  const shellName = path.basename(shellPath).toLowerCase();
  if (shellName === "zsh") {
    // Prevent zsh "no matches found" hard-fail loops on unmatched globs.
    return `setopt nonomatch 2>/dev/null; ${command}`;
  }
  return command;
}

async function runExecProcess(opts: {
  command: string;
  workdir: string;
  env: Record<string, string>;
  sandbox?: BashSandboxConfig;
  containerWorkdir?: string | null;
  usePty: boolean;
  warnings: string[];
  maxOutput: number;
  pendingMaxOutput: number;
  notifyOnExit: boolean;
  scopeKey?: string;
  sessionKey?: string;
  timeoutSec: number;
  memoryLimitMB?: number;
  policyDiagnostics?: ExecPolicyDiagnostics;
  onUpdate?: (partialResult: AgentToolResult<ExecToolDetails>) => void;
}): Promise<ExecProcessHandle> {
  const startedAt = Date.now();
  const sessionId = createSessionSlug();
  let child: ChildProcessWithoutNullStreams | null = null;
  let pty: PtyHandle | null = null;
  let stdin: SessionStdin | undefined;

  // Apply memory limit to non-sandbox commands (sandbox has its own cgroup limits).
  const effectiveCommand = opts.sandbox
    ? opts.command
    : wrapWithMemoryLimit(opts.command, opts.memoryLimitMB);

  if (opts.sandbox) {
    const { child: spawned } = await spawnWithFallback({
      argv: [
        "docker",
        ...buildDockerExecArgs({
          containerName: opts.sandbox.containerName,
          command: opts.command,
          workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
          env: opts.env,
          tty: opts.usePty,
        }),
      ],
      options: {
        cwd: opts.workdir,
        env: process.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
      fallbacks: [
        {
          label: "no-detach",
          options: { detached: false },
        },
      ],
      onFallback: (err, fallback) => {
        const errText = formatSpawnError(err);
        const warning = `Warning: spawn failed (${errText}); retrying with ${fallback.label}.`;
        logWarn(`exec: spawn failed (${errText}); retrying with ${fallback.label}.`);
        opts.warnings.push(warning);
      },
    });
    child = spawned as ChildProcessWithoutNullStreams;
    stdin = child.stdin;
  } else if (opts.usePty) {
    const { shell, args: shellArgs } = getShellConfig();
    const shellCommand = applyShellCompatPrefixes(effectiveCommand, shell);
    try {
      const ptyModule = (await import("@lydell/node-pty")) as unknown as {
        spawn?: PtySpawn;
        default?: { spawn?: PtySpawn };
      };
      const spawnPty = ptyModule.spawn ?? ptyModule.default?.spawn;
      if (!spawnPty) {
        throw new Error("PTY support is unavailable (node-pty spawn not found).");
      }
      pty = spawnPty(shell, [...shellArgs, shellCommand], {
        cwd: opts.workdir,
        env: opts.env,
        name: process.env.TERM ?? "xterm-256color",
        cols: 120,
        rows: 30,
      });
      stdin = {
        destroyed: false,
        write: (data, cb) => {
          try {
            pty?.write(data);
            cb?.(null);
          } catch (err) {
            cb?.(err as Error);
          }
        },
        end: () => {
          try {
            const eof = process.platform === "win32" ? "\x1a" : "\x04";
            pty?.write(eof);
          } catch {
            // ignore EOF errors
          }
        },
      };
    } catch (err) {
      const errText = String(err);
      const warning = `Warning: PTY spawn failed (${errText}); retrying without PTY for \`${opts.command}\`.`;
      logWarn(`exec: PTY spawn failed (${errText}); retrying without PTY for "${opts.command}".`);
      opts.warnings.push(warning);
      const { child: spawned } = await spawnWithFallback({
        argv: [shell, ...shellArgs, shellCommand],
        options: {
          cwd: opts.workdir,
          env: opts.env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
        fallbacks: [
          {
            label: "no-detach",
            options: { detached: false },
          },
        ],
        onFallback: (fallbackErr, fallback) => {
          const fallbackText = formatSpawnError(fallbackErr);
          const fallbackWarning = `Warning: spawn failed (${fallbackText}); retrying with ${fallback.label}.`;
          logWarn(`exec: spawn failed (${fallbackText}); retrying with ${fallback.label}.`);
          opts.warnings.push(fallbackWarning);
        },
      });
      child = spawned as ChildProcessWithoutNullStreams;
      stdin = child.stdin;
    }
  } else {
    const { shell, args: shellArgs } = getShellConfig();
    const shellCommand = applyShellCompatPrefixes(effectiveCommand, shell);
    const { child: spawned } = await spawnWithFallback({
      argv: [shell, ...shellArgs, shellCommand],
      options: {
        cwd: opts.workdir,
        env: opts.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
      fallbacks: [
        {
          label: "no-detach",
          options: { detached: false },
        },
      ],
      onFallback: (err, fallback) => {
        const errText = formatSpawnError(err);
        const warning = `Warning: spawn failed (${errText}); retrying with ${fallback.label}.`;
        logWarn(`exec: spawn failed (${errText}); retrying with ${fallback.label}.`);
        opts.warnings.push(warning);
      },
    });
    child = spawned as ChildProcessWithoutNullStreams;
    stdin = child.stdin;
  }

  const session = {
    id: sessionId,
    command: opts.command,
    scopeKey: opts.scopeKey,
    sessionKey: opts.sessionKey,
    notifyOnExit: opts.notifyOnExit,
    exitNotified: false,
    child: child ?? undefined,
    stdin,
    pid: child?.pid ?? pty?.pid,
    startedAt,
    cwd: opts.workdir,
    maxOutputChars: opts.maxOutput,
    pendingMaxOutputChars: opts.pendingMaxOutput,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "",
    tail: "",
    exited: false,
    exitCode: undefined as number | null | undefined,
    exitSignal: undefined as NodeJS.Signals | number | null | undefined,
    truncated: false,
    backgrounded: false,
  } satisfies ProcessSession;
  addSession(session);

  let settled = false;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let timeoutFinalizeTimer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const timeoutFinalizeMs = 1000;
  let resolveFn: ((outcome: ExecProcessOutcome) => void) | null = null;

  const settle = (outcome: ExecProcessOutcome) => {
    if (settled) {
      return;
    }
    settled = true;
    resolveFn?.(outcome);
  };

  const finalizeTimeout = () => {
    if (session.exited) {
      return;
    }
    markExited(session, null, "SIGKILL", "failed");
    maybeNotifyOnExit(session, "failed");
    const aggregated = session.aggregated.trim();
    const reason = `Command timed out after ${opts.timeoutSec} seconds`;
    settle({
      status: "failed",
      exitCode: null,
      exitSignal: "SIGKILL",
      durationMs: Date.now() - startedAt,
      aggregated,
      timedOut: true,
      reason: aggregated ? `${aggregated}\n\n${reason}` : reason,
    });
  };

  const onTimeout = () => {
    timedOut = true;
    killSession(session);
    if (!timeoutFinalizeTimer) {
      timeoutFinalizeTimer = setTimeout(() => {
        finalizeTimeout();
      }, timeoutFinalizeMs);
    }
  };

  if (opts.timeoutSec > 0) {
    timeoutTimer = setTimeout(() => {
      onTimeout();
    }, opts.timeoutSec * 1000);
  }

  const emitUpdate = () => {
    if (!opts.onUpdate) {
      return;
    }
    const tailText = session.tail || session.aggregated;
    const warningText = opts.warnings.length ? `${opts.warnings.join("\n")}\n\n` : "";
    opts.onUpdate({
      content: [{ type: "text", text: warningText + (tailText || "") }],
      details: {
        status: "running",
        sessionId,
        pid: session.pid ?? undefined,
        startedAt,
        cwd: session.cwd,
        tail: session.tail,
        policy: opts.policyDiagnostics,
      },
    });
  };

  const handleStdout = (data: string) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stdout", chunk);
      emitUpdate();
    }
  };

  const handleStderr = (data: string) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stderr", chunk);
      emitUpdate();
    }
  };

  if (pty) {
    const cursorResponse = buildCursorPositionResponse();
    pty.onData((data) => {
      const raw = data.toString();
      const { cleaned, requests } = stripDsrRequests(raw);
      if (requests > 0) {
        for (let i = 0; i < requests; i += 1) {
          pty.write(cursorResponse);
        }
      }
      handleStdout(cleaned);
    });
  } else if (child) {
    child.stdout.on("data", handleStdout);
    child.stderr.on("data", handleStderr);
  }

  const promise = new Promise<ExecProcessOutcome>((resolve) => {
    resolveFn = resolve;
    const handleExit = (code: number | null, exitSignal: NodeJS.Signals | number | null) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (timeoutFinalizeTimer) {
        clearTimeout(timeoutFinalizeTimer);
      }
      const durationMs = Date.now() - startedAt;
      const wasSignal = exitSignal != null;
      const isSuccess = code === 0 && !wasSignal && !timedOut;
      const status: "completed" | "failed" = isSuccess ? "completed" : "failed";
      markExited(session, code, exitSignal, status);
      maybeNotifyOnExit(session, status);
      if (!session.child && session.stdin) {
        session.stdin.destroyed = true;
      }

      if (settled) {
        return;
      }
      const aggregated = session.aggregated.trim();
      if (!isSuccess) {
        const memoryKillHint =
          opts.memoryLimitMB &&
          opts.memoryLimitMB > 0 &&
          (exitSignal === "SIGKILL" || exitSignal === 9 || code === 137)
            ? ` (likely exceeded memory limit of ${opts.memoryLimitMB}MB — ` +
              `consider splitting work into smaller chunks or increasing the limit ` +
              `via memoryLimitMB parameter)`
            : "";
        const reasonMsg = timedOut
          ? `Command timed out after ${opts.timeoutSec} seconds`
          : wasSignal && exitSignal
            ? `Command killed by signal ${exitSignal}${memoryKillHint}`
            : code === null
              ? "Command aborted before exit code was captured"
              : code === 137
                ? `Command killed (exit code 137)${memoryKillHint}`
                : `Command exited with code ${code}`;
        let finalReason = aggregated ? `${aggregated}\n\n${reasonMsg}` : reasonMsg;

        // Hinting for command not found
        if (
          aggregated.includes("command not found") ||
          aggregated.includes("no such file or directory") ||
          aggregated.includes("zsh: command not found") ||
          aggregated.includes("bash: command not found")
        ) {
          const cmd = opts.command.split(" ")[0];
          finalReason += `\n\nHint: The command '${cmd}' failed. Verify it exists with 'which ${cmd}' or use the absolute path.`;
        }

        settle({
          status: "failed",
          exitCode: code ?? null,
          exitSignal: exitSignal ?? null,
          durationMs,
          aggregated,
          timedOut,
          reason: finalReason,
        });
        return;
      }
      settle({
        status: "completed",
        exitCode: code ?? 0,
        exitSignal: exitSignal ?? null,
        durationMs,
        aggregated,
        timedOut: false,
      });
    };

    if (pty) {
      pty.onExit((event) => {
        const rawSignal = event.signal ?? null;
        const normalizedSignal = rawSignal === 0 ? null : rawSignal;
        handleExit(event.exitCode ?? null, normalizedSignal);
      });
    } else if (child) {
      child.once("close", (code, exitSignal) => {
        handleExit(code, exitSignal);
      });

      child.once("error", (err) => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (timeoutFinalizeTimer) {
          clearTimeout(timeoutFinalizeTimer);
        }
        markExited(session, null, null, "failed");
        maybeNotifyOnExit(session, "failed");
        const aggregated = session.aggregated.trim();
        const message = aggregated ? `${aggregated}\n\n${String(err)}` : String(err);
        settle({
          status: "failed",
          exitCode: null,
          exitSignal: null,
          durationMs: Date.now() - startedAt,
          aggregated,
          timedOut,
          reason: message,
        });
      });
    }
  });

  return {
    session,
    startedAt,
    pid: session.pid ?? undefined,
    promise,
    kill: () => killSession(session),
  };
}

export function createExecTool(
  defaults?: ExecToolDefaults,
  // oxlint-disable-next-line typescript/no-explicit-any
): AgentTool<any, ExecToolDetails> {
  const defaultBackgroundMs = clampNumber(
    defaults?.backgroundMs ?? readEnvInt("PI_BASH_YIELD_MS"),
    10_000,
    10,
    120_000,
  );
  const allowBackground = defaults?.allowBackground ?? true;
  const defaultTimeoutSec =
    typeof defaults?.timeoutSec === "number" && defaults.timeoutSec > 0
      ? defaults.timeoutSec
      : 1800;
  const defaultMemoryLimitMB =
    typeof defaults?.memoryLimitMB === "number" && defaults.memoryLimitMB > 0
      ? defaults.memoryLimitMB
      : 0;
  const defaultPathPrepend = normalizePathPrepend(defaults?.pathPrepend);
  const safeBins = resolveSafeBins(defaults?.safeBins);
  const notifyOnExit = defaults?.notifyOnExit !== false;
  const notifySessionKey = defaults?.sessionKey?.trim() || undefined;
  const approvalRunningNoticeMs = resolveApprovalRunningNoticeMs(defaults?.approvalRunningNoticeMs);
  const autoBackgroundMode = resolveExecPolicyMode(
    defaults?.autoBackgroundMode,
    "OPENCLAW_EXEC_AUTO_BACKGROUND_MODE",
    "enforce",
  );
  const retryBrakeMode = resolveExecPolicyMode(
    defaults?.retryBrakeMode,
    "OPENCLAW_EXEC_RETRY_BRAKE_MODE",
    "enforce",
  );
  // Derive agentId only when sessionKey is an agent session key.
  const parsedAgentSession = parseAgentSessionKey(defaults?.sessionKey);
  const agentId =
    defaults?.agentId ??
    (parsedAgentSession ? resolveAgentIdFromSessionKey(defaults?.sessionKey) : undefined);

  return {
    name: "exec",
    label: "exec",
    description:
      "Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. Use pty=true for TTY-required commands (terminal UIs, coding agents).",
    parameters: execSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const params = args as {
        command: string;
        workdir?: string;
        env?: Record<string, string>;
        yieldMs?: number;
        background?: boolean;
        timeout?: number;
        pty?: boolean;
        elevated?: boolean;
        host?: string;
        security?: string;
        ask?: string;
        node?: string;
        memoryLimitMB?: number;
      };

      if (!params.command) {
        throw new Error("Provide a command to start.");
      }
      const parserShadowDecision = evaluatePathRepairDecisionShadowParser(params.command);
      const asyncFsShadowDecision = await evaluatePathRepairDecisionAsyncFs(params.command);
      let parserPrimaryDecision: PathRepairParityDecision = {
        decision: "no-op",
        blocked: false,
        reason: "not_evaluated",
      };
      let command = params.command;
      let warnings: string[] = [];
      try {
        const repairedCommand = repairExecCommandUnicodeSpacePaths(params.command);
        command = repairedCommand.command;
        warnings = [...repairedCommand.warnings];
        parserPrimaryDecision = {
          decision: repairedCommand.command !== params.command ? "rewrite" : "no-op",
          blocked: false,
          reason: repairedCommand.command !== params.command ? "unicode_path_rewrite" : "no_change",
        };
      } catch (err) {
        parserPrimaryDecision = {
          decision: "block",
          blocked: true,
          reason: err instanceof Error ? err.message : String(err),
        };
        emitExecPathRepairParityTelemetry({
          command: params.command,
          rolloutPlane: resolveExecRolloutPlane(),
          sessionKey: defaults?.sessionKey,
          agentId,
          parserPrimaryDecision: parserPrimaryDecision.decision,
          parserShadowDecision: parserShadowDecision.decision,
          parserPrimaryBlocked: parserPrimaryDecision.blocked,
          parserShadowBlocked: parserShadowDecision.blocked,
          parserPrimaryReason: parserPrimaryDecision.reason,
          parserShadowReason: parserShadowDecision.reason,
          asyncFsPrimaryDecision: parserPrimaryDecision.decision,
          asyncFsShadowDecision: asyncFsShadowDecision.decision,
          asyncFsPrimaryBlocked: parserPrimaryDecision.blocked,
          asyncFsShadowBlocked: asyncFsShadowDecision.blocked,
          asyncFsPrimaryReason: parserPrimaryDecision.reason,
          asyncFsShadowReason: asyncFsShadowDecision.reason,
        });
        throw err;
      }
      emitExecPathRepairParityTelemetry({
        command,
        rolloutPlane: resolveExecRolloutPlane(),
        sessionKey: defaults?.sessionKey,
        agentId,
        parserPrimaryDecision: parserPrimaryDecision.decision,
        parserShadowDecision: parserShadowDecision.decision,
        parserPrimaryBlocked: parserPrimaryDecision.blocked,
        parserShadowBlocked: parserShadowDecision.blocked,
        parserPrimaryReason: parserPrimaryDecision.reason,
        parserShadowReason: parserShadowDecision.reason,
        asyncFsPrimaryDecision: parserPrimaryDecision.decision,
        asyncFsShadowDecision: asyncFsShadowDecision.decision,
        asyncFsPrimaryBlocked: parserPrimaryDecision.blocked,
        asyncFsShadowBlocked: asyncFsShadowDecision.blocked,
        asyncFsPrimaryReason: parserPrimaryDecision.reason,
        asyncFsShadowReason: asyncFsShadowDecision.reason,
      });
      const retryBrake = checkExecRetryBrake(command);
      const retryBrakeBlocked = retryBrake.blocked;
      const retryBrakeEnforced = retryBrakeMode === "enforce" && retryBrakeBlocked;
      if (retryBrakeEnforced) {
        const waitSeconds = Math.max(1, Math.ceil(retryBrake.waitMs / 1000));
        const failureClass = retryBrake.failureClass ?? "recent";
        throw new Error(
          `blocked: exec retry brake active for this command (${failureClass}) for ${waitSeconds}s. ` +
            "Adjust command scope or timeout/memoryLimitMB before retrying.",
        );
      }
      if (retryBrakeBlocked && retryBrakeMode === "shadow") {
        const waitSeconds = Math.max(1, Math.ceil(retryBrake.waitMs / 1000));
        const failureClass = retryBrake.failureClass ?? "recent";
        warnings.push(
          `Shadow retry-brake: would block this command (${failureClass}) for ${waitSeconds}s, but running for comparison telemetry.`,
        );
      }

      // Memory limit: explicit param overrides config default. 0 = disabled.
      const effectiveMemoryLimitMB =
        typeof params.memoryLimitMB === "number"
          ? Math.max(0, params.memoryLimitMB)
          : defaultMemoryLimitMB;

      const maxOutput = DEFAULT_MAX_OUTPUT;
      const pendingMaxOutput = DEFAULT_PENDING_MAX_OUTPUT;
      const backgroundRequested = params.background === true;
      const yieldRequested = typeof params.yieldMs === "number";
      const heavyCandidate = isLikelyHeavyExecCommand(command);
      const autoBackgroundWouldBackground =
        allowBackground && !backgroundRequested && !yieldRequested && heavyCandidate;
      const autoBackgroundRequested =
        autoBackgroundMode === "enforce" && autoBackgroundWouldBackground;
      if (autoBackgroundWouldBackground && autoBackgroundMode === "enforce") {
        warnings.push(
          "Auto-background enabled: heavy command detected; follow with process poll/log for progress.",
        );
      }
      if (autoBackgroundWouldBackground && autoBackgroundMode === "shadow") {
        warnings.push(
          "Shadow auto-background: heavy command detected; would background in enforce mode.",
        );
      }
      if (!allowBackground && (backgroundRequested || yieldRequested)) {
        warnings.push("Warning: background execution is disabled; running synchronously.");
      }
      const policyDiagnostics: ExecPolicyDiagnostics = {
        autoBackground: {
          mode: autoBackgroundMode,
          heavyCandidate,
          wouldBackground: autoBackgroundWouldBackground,
          applied: autoBackgroundRequested,
        },
        retryBrake: {
          mode: retryBrakeMode,
          blocked: retryBrakeBlocked,
          enforced: retryBrakeEnforced,
          waitMs: retryBrake.waitMs,
          failureClass: retryBrake.failureClass,
        },
      };
      const yieldWindow = allowBackground
        ? backgroundRequested || autoBackgroundRequested
          ? 0
          : clampNumber(params.yieldMs ?? defaultBackgroundMs, defaultBackgroundMs, 10, 120_000)
        : null;
      const elevatedDefaults = defaults?.elevated;
      const elevatedAllowed = Boolean(elevatedDefaults?.enabled && elevatedDefaults.allowed);
      const elevatedDefaultMode =
        elevatedDefaults?.defaultLevel === "full"
          ? "full"
          : elevatedDefaults?.defaultLevel === "ask"
            ? "ask"
            : elevatedDefaults?.defaultLevel === "on"
              ? "ask"
              : "off";
      const effectiveDefaultMode = elevatedAllowed ? elevatedDefaultMode : "off";
      const elevatedMode =
        typeof params.elevated === "boolean"
          ? params.elevated
            ? elevatedDefaultMode === "full"
              ? "full"
              : "ask"
            : "off"
          : effectiveDefaultMode;
      const elevatedRequested = elevatedMode !== "off";
      if (elevatedRequested) {
        if (!elevatedDefaults?.enabled || !elevatedDefaults.allowed) {
          const runtime = defaults?.sandbox ? "sandboxed" : "direct";
          const gates: string[] = [];
          const contextParts: string[] = [];
          const provider = defaults?.messageProvider?.trim();
          const sessionKey = defaults?.sessionKey?.trim();
          if (provider) {
            contextParts.push(`provider=${provider}`);
          }
          if (sessionKey) {
            contextParts.push(`session=${sessionKey}`);
          }
          if (!elevatedDefaults?.enabled) {
            gates.push("enabled (tools.elevated.enabled / agents.list[].tools.elevated.enabled)");
          } else {
            gates.push(
              "allowFrom (tools.elevated.allowFrom.<provider> / agents.list[].tools.elevated.allowFrom.<provider>)",
            );
          }
          throw new Error(
            [
              `elevated is not available right now (runtime=${runtime}).`,
              `Failing gates: ${gates.join(", ")}`,
              contextParts.length > 0 ? `Context: ${contextParts.join(" ")}` : undefined,
              "Fix-it keys:",
              "- tools.elevated.enabled",
              "- tools.elevated.allowFrom.<provider>",
              "- agents.list[].tools.elevated.enabled",
              "- agents.list[].tools.elevated.allowFrom.<provider>",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
      }
      if (elevatedRequested) {
        logInfo(`exec: elevated command ${truncateMiddle(command, 120)}`);
      }
      const configuredHost = defaults?.host ?? "sandbox";
      const requestedHost = normalizeExecHost(params.host) ?? null;
      let host: ExecHost = requestedHost ?? configuredHost;
      if (!elevatedRequested && requestedHost && requestedHost !== configuredHost) {
        throw new Error(
          `exec host not allowed (requested ${renderExecHostLabel(requestedHost)}; ` +
            `configure tools.exec.host=${renderExecHostLabel(configuredHost)} to allow).`,
        );
      }
      if (elevatedRequested) {
        host = "gateway";
      }

      const configuredSecurity = defaults?.security ?? (host === "sandbox" ? "deny" : "allowlist");
      const requestedSecurity = normalizeExecSecurity(params.security);
      let security = minSecurity(configuredSecurity, requestedSecurity ?? configuredSecurity);
      if (elevatedRequested && elevatedMode === "full") {
        security = "full";
      }
      const configuredAsk = defaults?.ask ?? "on-miss";
      const requestedAsk = normalizeExecAsk(params.ask);
      let ask = maxAsk(configuredAsk, requestedAsk ?? configuredAsk);
      const bypassApprovals = elevatedRequested && elevatedMode === "full";
      if (bypassApprovals) {
        ask = "off";
      }

      const sandbox = host === "sandbox" ? defaults?.sandbox : undefined;
      const rawWorkdir = params.workdir?.trim() || defaults?.cwd || process.cwd();
      let workdir = rawWorkdir;
      let containerWorkdir = sandbox?.containerWorkdir;
      if (sandbox) {
        const resolved = await resolveSandboxWorkdir({
          workdir: rawWorkdir,
          sandbox,
          warnings,
        });
        workdir = resolved.hostWorkdir;
        containerWorkdir = resolved.containerWorkdir;
      } else {
        workdir = resolveWorkdir(rawWorkdir, warnings);
      }

      const baseEnv = coerceEnv(process.env);

      // Logic: Sandbox gets raw env. Host (gateway/node) must pass validation.
      // We validate BEFORE merging to prevent any dangerous vars from entering the stream.
      if (host !== "sandbox" && params.env) {
        validateHostEnv(params.env);
      }

      const mergedEnv = params.env ? { ...baseEnv, ...params.env } : baseEnv;

      const env = sandbox
        ? buildSandboxEnv({
            defaultPath: DEFAULT_PATH,
            paramsEnv: params.env,
            sandboxEnv: sandbox.env,
            containerWorkdir: containerWorkdir ?? sandbox.containerWorkdir,
          })
        : mergedEnv;

      if (!sandbox && host === "gateway" && !params.env?.PATH) {
        const shellPath = getShellPathFromLoginShell({
          env: process.env,
          timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
        });
        applyShellPath(env, shellPath);
      }
      applyPathPrepend(env, defaultPathPrepend);

      if (host === "node") {
        const approvals = resolveExecApprovals(agentId, { security, ask });
        const hostSecurity = minSecurity(security, approvals.agent.security);
        const hostAsk = maxAsk(ask, approvals.agent.ask);
        const askFallback = approvals.agent.askFallback;
        if (hostSecurity === "deny") {
          throw new Error("exec denied: host=node security=deny");
        }
        const boundNode = defaults?.node?.trim();
        const requestedNode = params.node?.trim();
        if (boundNode && requestedNode && boundNode !== requestedNode) {
          throw new Error(`exec node not allowed (bound to ${boundNode})`);
        }
        const nodeQuery = boundNode || requestedNode;
        const nodes = await listNodes({});
        if (nodes.length === 0) {
          throw new Error(
            "exec host=node requires a paired node (none available). This requires a companion app or node host.",
          );
        }
        let nodeId: string;
        try {
          nodeId = resolveNodeIdFromList(nodes, nodeQuery, !nodeQuery);
        } catch (err) {
          if (!nodeQuery && String(err).includes("node required")) {
            throw new Error(
              "exec host=node requires a node id when multiple nodes are available (set tools.exec.node or exec.node).",
              { cause: err },
            );
          }
          throw err;
        }
        const nodeInfo = nodes.find((entry) => entry.nodeId === nodeId);
        const supportsSystemRun = Array.isArray(nodeInfo?.commands)
          ? nodeInfo?.commands?.includes("system.run")
          : false;
        if (!supportsSystemRun) {
          throw new Error(
            "exec host=node requires a node that supports system.run (companion app or node host).",
          );
        }
        const argv = buildNodeShellCommand(command, nodeInfo?.platform);

        const nodeEnv = params.env ? { ...params.env } : undefined;

        if (nodeEnv) {
          applyPathPrepend(nodeEnv, defaultPathPrepend, { requireExisting: true });
        }
        const baseAllowlistEval = evaluateShellAllowlist({
          command,
          allowlist: [],
          safeBins: new Set(),
          cwd: workdir,
          env,
        });
        let analysisOk = baseAllowlistEval.analysisOk;
        let allowlistSatisfied = false;
        if (hostAsk === "on-miss" && hostSecurity === "allowlist" && analysisOk) {
          try {
            const approvalsSnapshot = await callGatewayTool<{ file: string }>(
              "exec.approvals.node.get",
              { timeoutMs: 10_000 },
              { nodeId },
            );
            const approvalsFile =
              approvalsSnapshot && typeof approvalsSnapshot === "object"
                ? approvalsSnapshot.file
                : undefined;
            if (approvalsFile && typeof approvalsFile === "object") {
              const resolved = resolveExecApprovalsFromFile({
                file: approvalsFile as ExecApprovalsFile,
                agentId,
                overrides: { security: "allowlist" },
              });
              // Allowlist-only precheck; safe bins are node-local and may diverge.
              const allowlistEval = evaluateShellAllowlist({
                command,
                allowlist: resolved.allowlist,
                safeBins: new Set(),
                cwd: workdir,
                env,
              });
              allowlistSatisfied = allowlistEval.allowlistSatisfied;
              analysisOk = allowlistEval.analysisOk;
            }
          } catch {
            // Fall back to requiring approval if node approvals cannot be fetched.
          }
        }
        const requiresAsk = requiresExecApproval({
          ask: hostAsk,
          security: hostSecurity,
          analysisOk,
          allowlistSatisfied,
        });
        const commandText = command;
        const invokeTimeoutMs = Math.max(
          10_000,
          (typeof params.timeout === "number" ? params.timeout : defaultTimeoutSec) * 1000 + 5_000,
        );
        const buildInvokeParams = (
          approvedByAsk: boolean,
          approvalDecision: "allow-once" | "allow-always" | null,
          runId?: string,
        ) =>
          ({
            nodeId,
            command: "system.run",
            params: {
              command: argv,
              rawCommand: command,
              cwd: workdir,
              env: nodeEnv,
              timeoutMs: typeof params.timeout === "number" ? params.timeout * 1000 : undefined,
              agentId,
              sessionKey: defaults?.sessionKey,
              approved: approvedByAsk,
              approvalDecision: approvalDecision ?? undefined,
              runId: runId ?? undefined,
            },
            idempotencyKey: crypto.randomUUID(),
          }) satisfies Record<string, unknown>;

        if (requiresAsk) {
          const approvalId = crypto.randomUUID();
          const approvalSlug = createApprovalSlug(approvalId);
          const expiresAtMs = Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
          const contextKey = `exec:${approvalId}`;
          const noticeSeconds = Math.max(1, Math.round(approvalRunningNoticeMs / 1000));
          const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";

          void (async () => {
            let decision: string | null = null;
            try {
              const decisionResult = await callGatewayTool<{ decision: string }>(
                "exec.approval.request",
                { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
                {
                  id: approvalId,
                  command: commandText,
                  cwd: workdir,
                  host: "node",
                  security: hostSecurity,
                  ask: hostAsk,
                  agentId,
                  resolvedPath: undefined,
                  sessionKey: defaults?.sessionKey,
                  timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
                },
              );
              const decisionValue =
                decisionResult && typeof decisionResult === "object"
                  ? (decisionResult as { decision?: unknown }).decision
                  : undefined;
              decision = typeof decisionValue === "string" ? decisionValue : null;
            } catch {
              emitDeferredExecTelemetry({
                host: "node",
                command: commandText,
                status: "failed",
                sessionKey: notifySessionKey,
                agentId,
                approvalId,
                nodeId,
                reason: "approval-request-failed",
              });
              emitExecSystemEvent(
                `Exec denied (node=${nodeId} id=${approvalId}, approval-request-failed): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
              return;
            }

            let approvedByAsk = false;
            let approvalDecision: "allow-once" | "allow-always" | null = null;
            let deniedReason: string | null = null;

            if (decision === "deny") {
              deniedReason = "user-denied";
            } else if (!decision) {
              if (askFallback === "full") {
                approvedByAsk = true;
                approvalDecision = "allow-once";
              } else if (askFallback === "allowlist") {
                // Defer allowlist enforcement to the node host.
              } else {
                deniedReason = "approval-timeout";
              }
            } else if (decision === "allow-once") {
              approvedByAsk = true;
              approvalDecision = "allow-once";
            } else if (decision === "allow-always") {
              approvedByAsk = true;
              approvalDecision = "allow-always";
            }

            if (deniedReason) {
              emitDeferredExecTelemetry({
                host: "node",
                command: commandText,
                status: "failed",
                sessionKey: notifySessionKey,
                agentId,
                approvalId,
                nodeId,
                reason: deniedReason,
              });
              emitExecSystemEvent(
                `Exec denied (node=${nodeId} id=${approvalId}, ${deniedReason}): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
              return;
            }

            let runningTimer: NodeJS.Timeout | null = null;
            if (approvalRunningNoticeMs > 0) {
              runningTimer = setTimeout(() => {
                emitExecSystemEvent(
                  `Exec running (node=${nodeId} id=${approvalId}, >${noticeSeconds}s): ${commandText}`,
                  { sessionKey: notifySessionKey, contextKey },
                );
              }, approvalRunningNoticeMs);
            }

            try {
              const invokeStartedAt = Date.now();
              await callGatewayTool(
                "node.invoke",
                { timeoutMs: invokeTimeoutMs },
                buildInvokeParams(approvedByAsk, approvalDecision, approvalId),
              );
              emitDeferredExecTelemetry({
                host: "node",
                command: commandText,
                status: "completed",
                sessionKey: notifySessionKey,
                agentId,
                approvalId,
                nodeId,
                durationMs: Date.now() - invokeStartedAt,
              });
            } catch {
              emitDeferredExecTelemetry({
                host: "node",
                command: commandText,
                status: "failed",
                sessionKey: notifySessionKey,
                agentId,
                approvalId,
                nodeId,
                reason: "invoke-failed",
              });
              emitExecSystemEvent(
                `Exec denied (node=${nodeId} id=${approvalId}, invoke-failed): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
            } finally {
              if (runningTimer) {
                clearTimeout(runningTimer);
              }
            }
          })();

          return {
            content: [
              {
                type: "text",
                text:
                  `${warningText}Approval required (id ${approvalSlug}). ` +
                  "Approve to run; updates will arrive after completion.",
              },
            ],
            details: {
              status: "approval-pending",
              approvalId,
              approvalSlug,
              expiresAtMs,
              host: "node",
              command: commandText,
              cwd: workdir,
              nodeId,
              policy: policyDiagnostics,
            },
          };
        }

        const startedAt = Date.now();
        const raw = await callGatewayTool(
          "node.invoke",
          { timeoutMs: invokeTimeoutMs },
          buildInvokeParams(false, null),
        );
        const payload =
          raw && typeof raw === "object" ? (raw as { payload?: unknown }).payload : undefined;
        const payloadObj =
          payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        const stdout = typeof payloadObj.stdout === "string" ? payloadObj.stdout : "";
        const stderr = typeof payloadObj.stderr === "string" ? payloadObj.stderr : "";
        const errorText = typeof payloadObj.error === "string" ? payloadObj.error : "";
        const success = typeof payloadObj.success === "boolean" ? payloadObj.success : false;
        const exitCode = typeof payloadObj.exitCode === "number" ? payloadObj.exitCode : null;
        return {
          content: [
            {
              type: "text",
              text: stdout || stderr || errorText || "",
            },
          ],
          details: {
            status: success ? "completed" : "failed",
            command,
            exitCode,
            durationMs: Date.now() - startedAt,
            aggregated: [stdout, stderr, errorText].filter(Boolean).join("\n"),
            cwd: workdir,
            policy: policyDiagnostics,
          } satisfies ExecToolDetails,
        };
      }

      if (host === "gateway" && !bypassApprovals) {
        const approvals = resolveExecApprovals(agentId, { security, ask });
        const hostSecurity = minSecurity(security, approvals.agent.security);
        const hostAsk = maxAsk(ask, approvals.agent.ask);
        const askFallback = approvals.agent.askFallback;
        if (hostSecurity === "deny") {
          throw new Error("exec denied: host=gateway security=deny");
        }
        const allowlistEval = evaluateShellAllowlist({
          command,
          allowlist: approvals.allowlist,
          safeBins,
          cwd: workdir,
          env,
        });
        const allowlistMatches = allowlistEval.allowlistMatches;
        const analysisOk = allowlistEval.analysisOk;
        const allowlistSatisfied =
          hostSecurity === "allowlist" && analysisOk ? allowlistEval.allowlistSatisfied : false;
        const requiresAsk = requiresExecApproval({
          ask: hostAsk,
          security: hostSecurity,
          analysisOk,
          allowlistSatisfied,
        });

        if (requiresAsk) {
          const approvalId = crypto.randomUUID();
          const approvalSlug = createApprovalSlug(approvalId);
          const expiresAtMs = Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS;
          const contextKey = `exec:${approvalId}`;
          const resolvedPath = allowlistEval.segments[0]?.resolution?.resolvedPath;
          const noticeSeconds = Math.max(1, Math.round(approvalRunningNoticeMs / 1000));
          const commandText = command;
          const effectiveTimeout =
            typeof params.timeout === "number" ? params.timeout : defaultTimeoutSec;
          const warningText = warnings.length ? `${warnings.join("\n")}\n\n` : "";

          void (async () => {
            let decision: string | null = null;
            try {
              const decisionResult = await callGatewayTool<{ decision: string }>(
                "exec.approval.request",
                { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS },
                {
                  id: approvalId,
                  command: commandText,
                  cwd: workdir,
                  host: "gateway",
                  security: hostSecurity,
                  ask: hostAsk,
                  agentId,
                  resolvedPath,
                  sessionKey: defaults?.sessionKey,
                  timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
                },
              );
              const decisionValue =
                decisionResult && typeof decisionResult === "object"
                  ? (decisionResult as { decision?: unknown }).decision
                  : undefined;
              decision = typeof decisionValue === "string" ? decisionValue : null;
            } catch {
              emitDeferredExecTelemetry({
                host: "gateway",
                command: commandText,
                status: "failed",
                sessionKey: notifySessionKey,
                agentId,
                approvalId,
                reason: "approval-request-failed",
              });
              emitExecSystemEvent(
                `Exec denied (gateway id=${approvalId}, approval-request-failed): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
              return;
            }

            let approvedByAsk = false;
            let deniedReason: string | null = null;

            if (decision === "deny") {
              deniedReason = "user-denied";
            } else if (!decision) {
              if (askFallback === "full") {
                approvedByAsk = true;
              } else if (askFallback === "allowlist") {
                if (!analysisOk || !allowlistSatisfied) {
                  deniedReason = "approval-timeout (allowlist-miss)";
                } else {
                  approvedByAsk = true;
                }
              } else {
                deniedReason = "approval-timeout";
              }
            } else if (decision === "allow-once") {
              approvedByAsk = true;
            } else if (decision === "allow-always") {
              approvedByAsk = true;
              if (hostSecurity === "allowlist") {
                for (const segment of allowlistEval.segments) {
                  const pattern = segment.resolution?.resolvedPath ?? "";
                  if (pattern) {
                    addAllowlistEntry(approvals.file, agentId, pattern);
                  }
                }
              }
            }

            if (
              hostSecurity === "allowlist" &&
              (!analysisOk || !allowlistSatisfied) &&
              !approvedByAsk
            ) {
              deniedReason = deniedReason ?? "allowlist-miss";
            }

            if (deniedReason) {
              emitDeferredExecTelemetry({
                host: "gateway",
                command: commandText,
                status: "failed",
                sessionKey: notifySessionKey,
                agentId,
                approvalId,
                reason: deniedReason,
              });
              emitExecSystemEvent(
                `Exec denied (gateway id=${approvalId}, ${deniedReason}): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
              return;
            }

            if (allowlistMatches.length > 0) {
              const seen = new Set<string>();
              for (const match of allowlistMatches) {
                if (seen.has(match.pattern)) {
                  continue;
                }
                seen.add(match.pattern);
                recordAllowlistUse(
                  approvals.file,
                  agentId,
                  match,
                  commandText,
                  resolvedPath ?? undefined,
                );
              }
            }

            let run: ExecProcessHandle | null = null;
            try {
              run = await runExecProcess({
                command: commandText,
                workdir,
                env,
                sandbox: undefined,
                containerWorkdir: null,
                usePty: params.pty === true && !sandbox,
                warnings,
                maxOutput,
                pendingMaxOutput,
                notifyOnExit: false,
                scopeKey: defaults?.scopeKey,
                sessionKey: notifySessionKey,
                timeoutSec: effectiveTimeout,
                memoryLimitMB: effectiveMemoryLimitMB,
              });
            } catch {
              emitDeferredExecTelemetry({
                host: "gateway",
                command: commandText,
                status: "failed",
                sessionKey: notifySessionKey,
                agentId,
                approvalId,
                reason: "spawn-failed",
              });
              emitExecSystemEvent(
                `Exec denied (gateway id=${approvalId}, spawn-failed): ${commandText}`,
                { sessionKey: notifySessionKey, contextKey },
              );
              return;
            }

            markBackgrounded(run.session);

            let runningTimer: NodeJS.Timeout | null = null;
            if (approvalRunningNoticeMs > 0) {
              runningTimer = setTimeout(() => {
                emitExecSystemEvent(
                  `Exec running (gateway id=${approvalId}, session=${run?.session.id}, >${noticeSeconds}s): ${commandText}`,
                  { sessionKey: notifySessionKey, contextKey },
                );
              }, approvalRunningNoticeMs);
            }

            const outcome = await run.promise;
            if (runningTimer) {
              clearTimeout(runningTimer);
            }
            if (outcome.status === "completed") {
              clearExecRetryBrake(commandText);
            } else {
              recordExecRetryBrakeFailure(commandText, outcome.reason);
            }
            const output = normalizeNotifyOutput(
              tail(outcome.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
            );
            const exitLabel = outcome.timedOut ? "timeout" : `code ${outcome.exitCode ?? "?"}`;
            const summary = output
              ? `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})\n${output}`
              : `Exec finished (gateway id=${approvalId}, session=${run.session.id}, ${exitLabel})`;
            emitDeferredExecTelemetry({
              host: "gateway",
              command: commandText,
              status: outcome.status === "completed" ? "completed" : "failed",
              sessionKey: notifySessionKey,
              agentId,
              approvalId,
              durationMs: outcome.durationMs,
              exitCode: outcome.exitCode,
              reason: outcome.timedOut ? "timeout" : undefined,
            });
            emitExecSystemEvent(summary, { sessionKey: notifySessionKey, contextKey });
          })();

          return {
            content: [
              {
                type: "text",
                text:
                  `${warningText}Approval required (id ${approvalSlug}). ` +
                  "Approve to run; updates will arrive after completion.",
              },
            ],
            details: {
              status: "approval-pending",
              approvalId,
              approvalSlug,
              expiresAtMs,
              host: "gateway",
              command,
              cwd: workdir,
              policy: policyDiagnostics,
            },
          };
        }

        if (hostSecurity === "allowlist" && (!analysisOk || !allowlistSatisfied)) {
          throw new Error("exec denied: allowlist miss");
        }

        if (allowlistMatches.length > 0) {
          const seen = new Set<string>();
          for (const match of allowlistMatches) {
            if (seen.has(match.pattern)) {
              continue;
            }
            seen.add(match.pattern);
            recordAllowlistUse(
              approvals.file,
              agentId,
              match,
              command,
              allowlistEval.segments[0]?.resolution?.resolvedPath,
            );
          }
        }
      }

      const effectiveTimeout =
        typeof params.timeout === "number" ? params.timeout : defaultTimeoutSec;
      const getWarningText = () => (warnings.length ? `${warnings.join("\n")}\n\n` : "");
      const usePty = params.pty === true && !sandbox;
      const run = await runExecProcess({
        command,
        workdir,
        env,
        sandbox,
        containerWorkdir,
        usePty,
        warnings,
        maxOutput,
        pendingMaxOutput,
        notifyOnExit,
        scopeKey: defaults?.scopeKey,
        sessionKey: notifySessionKey,
        timeoutSec: effectiveTimeout,
        memoryLimitMB: effectiveMemoryLimitMB,
        policyDiagnostics,
        onUpdate,
      });

      let yielded = false;
      let yieldTimer: NodeJS.Timeout | null = null;

      // Tool-call abort should not kill backgrounded sessions; timeouts still must.
      const onAbortSignal = () => {
        if (yielded || run.session.backgrounded) {
          return;
        }
        run.kill();
      };

      if (signal?.aborted) {
        onAbortSignal();
      } else if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
      }

      return new Promise<AgentToolResult<ExecToolDetails>>((resolve, reject) => {
        const resolveRunning = () =>
          resolve({
            content: [
              {
                type: "text",
                text: `${getWarningText()}Command still running (session ${run.session.id}, pid ${
                  run.session.pid ?? "n/a"
                }). Use process (list/poll/log/write/kill/clear/remove) for follow-up.`,
              },
            ],
            details: {
              status: "running",
              sessionId: run.session.id,
              pid: run.session.pid ?? undefined,
              startedAt: run.startedAt,
              cwd: run.session.cwd,
              tail: run.session.tail,
              policy: policyDiagnostics,
            },
          });

        const onYieldNow = () => {
          if (yieldTimer) {
            clearTimeout(yieldTimer);
          }
          if (yielded) {
            return;
          }
          yielded = true;
          markBackgrounded(run.session);
          resolveRunning();
        };

        if (allowBackground && yieldWindow !== null) {
          if (yieldWindow === 0) {
            onYieldNow();
          } else {
            yieldTimer = setTimeout(() => {
              if (yielded) {
                return;
              }
              yielded = true;
              markBackgrounded(run.session);
              resolveRunning();
            }, yieldWindow);
          }
        }

        run.promise
          .then((outcome) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            if (outcome.status === "failed") {
              recordExecRetryBrakeFailure(command, outcome.reason);
              reject(new Error(outcome.reason ?? "Command failed."));
              return;
            }
            clearExecRetryBrake(command);
            resolve({
              content: [
                {
                  type: "text",
                  text: `${getWarningText()}${outcome.aggregated || "(no output)"}`,
                },
              ],
              details: {
                status: "completed",
                command,
                exitCode: outcome.exitCode ?? 0,
                durationMs: outcome.durationMs,
                aggregated: outcome.aggregated,
                cwd: run.session.cwd,
                policy: policyDiagnostics,
              },
            });
          })
          .catch((err) => {
            if (yieldTimer) {
              clearTimeout(yieldTimer);
            }
            if (yielded || run.session.backgrounded) {
              return;
            }
            recordExecRetryBrakeFailure(command, String(err));
            reject(err as Error);
          });
      });
    },
  };
}

export const execTool = createExecTool();
