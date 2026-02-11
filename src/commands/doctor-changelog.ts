/**
 * Doctor Changelog — persistent audit trail of all config mutations made by `openclaw doctor`.
 *
 * Every time the doctor modifies openclaw.json, an entry is appended to a JSONL changelog.
 * This allows retracing what happened if a doctor run silently breaks runtime features.
 *
 * Canonical location: <workspace>/os/audits/doctor-changelog.jsonl  (git-tracked)
 * Symlink:            <stateDir>/doctor-changelog.jsonl              (engine read/write)
 *
 * The engine always writes to the stateDir path. If a symlink exists pointing into the
 * workspace, git automatically tracks the content.
 */

import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";

export interface DoctorChangelogEntry {
  /** ISO-8601 timestamp */
  timestamp: string;
  /** OpenClaw version that ran the doctor */
  version: string;
  /** What triggered the change: "doctor --fix", "doctor --yes", "doctor (interactive)" */
  trigger: string;
  /** Category of change */
  action:
    | "stripped_unknown_keys"
    | "legacy_migration"
    | "legacy_normalization"
    | "plugin_auto_enable";
  /** Human-readable summary */
  summary: string;
  /** Detailed list of what changed */
  changes: DoctorChangeDetail[];
}

export interface DoctorChangeDetail {
  /** Dot-path to the config key (e.g. "tools.agentToAgent.deliveryMode") */
  path: string;
  /** What happened: removed, migrated, added, changed */
  operation: "removed" | "migrated" | "added" | "changed";
  /** The value before the change (serialized) */
  oldValue?: unknown;
  /** The value after the change (serialized), undefined if removed */
  newValue?: unknown;
}

/**
 * Resolve the changelog path. Always writes to <stateDir>/doctor-changelog.jsonl.
 * If a symlink exists pointing into the workspace, git tracks it automatically.
 */
export function resolveChangelogPath(stateDir: string = STATE_DIR): string {
  return path.join(stateDir, "doctor-changelog.jsonl");
}

/**
 * Append a changelog entry. Fire-and-forget — never throws.
 */
export function appendDoctorChangelog(entry: DoctorChangelogEntry): void {
  try {
    const logPath = resolveChangelogPath();
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(logPath, line, "utf-8");
  } catch {
    // Best-effort — changelog write failure must never block the doctor.
  }
}

/**
 * Build a changelog entry for stripped unknown keys.
 * Captures the old values from the original config so they can be restored.
 */
export function buildStrippedKeysEntry(params: {
  removedPaths: string[];
  originalConfig: Record<string, unknown>;
  trigger: string;
  version: string;
}): DoctorChangelogEntry {
  const changes: DoctorChangeDetail[] = params.removedPaths.map((keyPath) => {
    const oldValue = resolveValueAtPath(params.originalConfig, keyPath);
    return {
      path: keyPath,
      operation: "removed" as const,
      oldValue,
    };
  });

  return {
    timestamp: new Date().toISOString(),
    version: params.version,
    trigger: params.trigger,
    action: "stripped_unknown_keys",
    summary: `Removed ${params.removedPaths.length} unrecognized config key(s): ${params.removedPaths.join(", ")}`,
    changes,
  };
}

/**
 * Build a generic changelog entry for other doctor mutations (legacy, normalization, etc.)
 */
export function buildGenericEntry(params: {
  action: DoctorChangelogEntry["action"];
  changeDescriptions: string[];
  trigger: string;
  version: string;
}): DoctorChangelogEntry {
  const changes: DoctorChangeDetail[] = params.changeDescriptions.map((desc) => ({
    path: desc,
    operation: "changed" as const,
  }));

  return {
    timestamp: new Date().toISOString(),
    version: params.version,
    trigger: params.trigger,
    action: params.action,
    summary: `${params.action}: ${params.changeDescriptions.length} change(s)`,
    changes,
  };
}

/**
 * Resolve a dot-path value from a nested object.
 * e.g. resolveValueAtPath(obj, "tools.exec.memoryLimitMB") → 8192
 */
function resolveValueAtPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
