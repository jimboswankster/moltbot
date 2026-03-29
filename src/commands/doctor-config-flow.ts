import type { ZodIssue } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  OpenClawSchema,
  CONFIG_PATH,
  migrateLegacyConfig,
  readConfigFileSnapshot,
} from "../config/config.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { note } from "../terminal/note.js";
import { resolveHomeDir } from "../utils.js";
import { VERSION } from "../version.js";
import {
  appendDoctorChangelog,
  buildStrippedKeysEntry,
  buildGenericEntry,
} from "./doctor-changelog.js";
import { normalizeLegacyConfigValues } from "./doctor-legacy-config.js";
import { autoMigrateLegacyStateDir } from "./doctor-state-migrations.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

type UnrecognizedKeysIssue = ZodIssue & {
  code: "unrecognized_keys";
  keys: PropertyKey[];
};

function normalizeIssuePath(path: PropertyKey[]): Array<string | number> {
  return path.filter((part): part is string | number => typeof part !== "symbol");
}

function isUnrecognizedKeysIssue(issue: ZodIssue): issue is UnrecognizedKeysIssue {
  return issue.code === "unrecognized_keys";
}

function formatPath(parts: Array<string | number>): string {
  if (parts.length === 0) {
    return "<root>";
  }
  let out = "";
  for (const part of parts) {
    if (typeof part === "number") {
      out += `[${part}]`;
      continue;
    }
    out = out ? `${out}.${part}` : part;
  }
  return out || "<root>";
}

function resolvePathTarget(root: unknown, path: Array<string | number>): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (typeof part === "number") {
      if (!Array.isArray(current)) {
        return null;
      }
      if (part < 0 || part >= current.length) {
        return null;
      }
      current = current[part];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return null;
    }
    const record = current as Record<string, unknown>;
    if (!(part in record)) {
      return null;
    }
    current = record[part];
  }
  return current;
}

function stripUnknownConfigKeys(config: OpenClawConfig): {
  config: OpenClawConfig;
  removed: string[];
  removedValues: Array<{ path: string; value: unknown }>;
} {
  const parsed = OpenClawSchema.safeParse(config);
  if (parsed.success) {
    return { config, removed: [], removedValues: [] };
  }

  const next = structuredClone(config);
  const removed: string[] = [];
  const removedValues: Array<{ path: string; value: unknown }> = [];
  for (const issue of parsed.error.issues) {
    if (!isUnrecognizedKeysIssue(issue)) {
      continue;
    }
    const path = normalizeIssuePath(issue.path);
    const target = resolvePathTarget(next, path);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      continue;
    }
    const record = target as Record<string, unknown>;
    for (const key of issue.keys) {
      if (typeof key !== "string") {
        continue;
      }
      if (!(key in record)) {
        continue;
      }
      const keyPath = formatPath([...path, key]);
      removedValues.push({ path: keyPath, value: structuredClone(record[key]) });
      delete record[key];
      removed.push(keyPath);
    }
  }

  return { config: next, removed, removedValues };
}

function noteOpencodeProviderOverrides(cfg: OpenClawConfig) {
  const providers = cfg.models?.providers;
  if (!providers) {
    return;
  }

  // 2026-01-10: warn when OpenCode Zen overrides mask built-in routing/costs (8a194b4abc360c6098f157956bb9322576b44d51, 2d105d16f8a099276114173836d46b46cdfbdbae).
  const overrides: string[] = [];
  if (providers.opencode) {
    overrides.push("opencode");
  }
  if (providers["opencode-zen"]) {
    overrides.push("opencode-zen");
  }
  if (overrides.length === 0) {
    return;
  }

  const lines = overrides.flatMap((id) => {
    const providerEntry = providers[id];
    const api =
      isRecord(providerEntry) && typeof providerEntry.api === "string"
        ? providerEntry.api
        : undefined;
    return [
      `- models.providers.${id} is set; this overrides the built-in OpenCode Zen catalog.`,
      api ? `- models.providers.${id}.api=${api}` : null,
    ].filter((line): line is string => Boolean(line));
  });

  lines.push(
    "- Remove these entries to restore per-model API routing + costs (then re-run onboarding if needed).",
  );

  note(lines.join("\n"), "OpenCode Zen");
}

async function maybeMigrateLegacyConfig(): Promise<string[]> {
  const changes: string[] = [];
  const home = resolveHomeDir();
  if (!home) {
    return changes;
  }

  const targetDir = path.join(home, ".openclaw");
  const targetPath = path.join(targetDir, "openclaw.json");
  try {
    await fs.access(targetPath);
    return changes;
  } catch {
    // missing config
  }

  const legacyCandidates = [
    path.join(home, ".clawdbot", "clawdbot.json"),
    path.join(home, ".moltbot", "moltbot.json"),
    path.join(home, ".moldbot", "moldbot.json"),
  ];

  let legacyPath: string | null = null;
  for (const candidate of legacyCandidates) {
    try {
      await fs.access(candidate);
      legacyPath = candidate;
      break;
    } catch {
      // continue
    }
  }
  if (!legacyPath) {
    return changes;
  }

  await fs.mkdir(targetDir, { recursive: true });
  try {
    await fs.copyFile(legacyPath, targetPath, fs.constants.COPYFILE_EXCL);
    changes.push(`Migrated legacy config: ${legacyPath} -> ${targetPath}`);
  } catch {
    // If it already exists, skip silently.
  }

  return changes;
}

export async function loadAndMaybeMigrateDoctorConfig(params: {
  options: DoctorOptions;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
}) {
  const dryRun = params.options.dryRun === true;
  const autoYes = params.options.yes === true;
  const wantsRepair = params.options.repair === true;
  // --yes auto-applies without prompting. --fix shows changes and prompts for confirmation.
  const shouldRepair = autoYes || wantsRepair;
  const trigger = dryRun
    ? "doctor --dry-run"
    : autoYes
      ? "doctor --yes"
      : wantsRepair
        ? "doctor --fix"
        : "doctor (interactive)";
  const version = VERSION;

  if (!dryRun) {
    const stateDirResult = await autoMigrateLegacyStateDir({ env: process.env });
    if (stateDirResult.changes.length > 0) {
      note(stateDirResult.changes.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
    }
    if (stateDirResult.warnings.length > 0) {
      note(stateDirResult.warnings.map((entry) => `- ${entry}`).join("\n"), "Doctor warnings");
    }
  }

  if (!dryRun) {
    const legacyConfigChanges = await maybeMigrateLegacyConfig();
    if (legacyConfigChanges.length > 0) {
      note(legacyConfigChanges.map((entry) => `- ${entry}`).join("\n"), "Doctor changes");
    }
  }

  let snapshot = await readConfigFileSnapshot();
  const baseCfg = snapshot.config ?? {};
  const originalConfig = structuredClone(baseCfg);
  let cfg: OpenClawConfig = baseCfg;
  let candidate = structuredClone(baseCfg);
  let pendingChanges = false;
  let shouldWriteConfig = false;
  const fixHints: string[] = [];
  if (snapshot.exists && !snapshot.valid && snapshot.legacyIssues.length === 0) {
    note("Config invalid; doctor will run with best-effort config.", "Config");
  }
  const warnings = snapshot.warnings ?? [];
  if (warnings.length > 0) {
    const lines = warnings.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
    note(lines, "Config warnings");
  }

  // Track all changes for the changelog
  const changelogEntries: Array<{ action: string; descriptions: string[] }> = [];

  if (snapshot.legacyIssues.length > 0) {
    note(
      snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"),
      "Legacy config keys detected",
    );
    const { config: migrated, changes } = migrateLegacyConfig(snapshot.parsed);
    if (changes.length > 0) {
      note(changes.join("\n"), "Doctor changes");
      changelogEntries.push({ action: "legacy_migration", descriptions: changes });
    }
    if (migrated) {
      candidate = migrated;
      pendingChanges = pendingChanges || changes.length > 0;
    }
    if (shouldRepair) {
      // Legacy migration (2026-01-02, commit: 16420e5b) — normalize per-provider allowlists; move WhatsApp gating into channels.whatsapp.allowFrom.
      if (migrated) {
        cfg = migrated;
      }
    } else {
      fixHints.push(
        `Run "${formatCliCommand("openclaw doctor --fix")}" to apply legacy migrations.`,
      );
    }
  }

  const normalized = normalizeLegacyConfigValues(candidate);
  if (normalized.changes.length > 0) {
    note(normalized.changes.join("\n"), "Doctor changes");
    candidate = normalized.config;
    pendingChanges = true;
    changelogEntries.push({ action: "legacy_normalization", descriptions: normalized.changes });
    if (shouldRepair) {
      cfg = normalized.config;
    } else {
      fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`);
    }
  }

  const autoEnable = applyPluginAutoEnable({ config: candidate, env: process.env });
  if (autoEnable.changes.length > 0) {
    note(autoEnable.changes.join("\n"), "Doctor changes");
    candidate = autoEnable.config;
    pendingChanges = true;
    changelogEntries.push({ action: "plugin_auto_enable", descriptions: autoEnable.changes });
    if (shouldRepair) {
      cfg = autoEnable.config;
    } else {
      fixHints.push(`Run "${formatCliCommand("openclaw doctor --fix")}" to apply these changes.`);
    }
  }

  const unknown = stripUnknownConfigKeys(candidate);
  if (unknown.removed.length > 0) {
    candidate = unknown.config;
    pendingChanges = true;

    // === TRIP SWITCH: show exactly what will be removed with current values ===
    const detailLines = unknown.removedValues.map(({ path: p, value }) => {
      const valueStr = typeof value === "object" ? JSON.stringify(value) : String(value);
      return `- ${p}: ${valueStr}`;
    });
    note(detailLines.join("\n"), "Keys to be REMOVED from config");
    note(
      "These keys are not recognized by the current engine schema.\n" +
        "If you added them intentionally, declining will preserve them.\n" +
        "All removals are logged to doctor-changelog.jsonl for recovery.",
      "Warning",
    );

    if (dryRun) {
      // Dry-run is analyze-only: report planned removals without applying.
    } else if (autoYes) {
      // --yes: auto-apply but still log
      cfg = unknown.config;
    } else if (wantsRepair) {
      // --fix: show and prompt (trip switch)
      const shouldStrip = await params.confirm({
        message: `Remove ${unknown.removed.length} unrecognized key(s) from config?`,
        initialValue: false,
      });
      if (shouldStrip) {
        cfg = unknown.config;
      } else {
        // User declined — revert the stripping by using pre-strip candidate
        note("Kept unrecognized keys. Config will remain as-is.", "Skipped");
        candidate = structuredClone(cfg);
        pendingChanges = false;
      }
    } else {
      // No flags: just show, don't apply
      note(unknown.removed.map((p) => `- ${p}`).join("\n"), "Unknown config keys");
      fixHints.push('Run "openclaw doctor --fix" to review and remove these keys.');
    }
  }

  if (!dryRun && !shouldRepair && pendingChanges) {
    const shouldApply = await params.confirm({
      message: "Apply recommended config repairs now?",
      initialValue: true,
    });
    if (shouldApply) {
      cfg = candidate;
      shouldWriteConfig = true;
    } else if (fixHints.length > 0) {
      note(fixHints.join("\n"), "Doctor");
    }
  }

  // === CHANGELOG: log what was actually applied ===
  const configWasModified = cfg !== baseCfg;
  if (!dryRun && configWasModified) {
    // Log stripped keys with full old values for recovery
    if (unknown.removed.length > 0 && cfg === unknown.config) {
      appendDoctorChangelog(
        buildStrippedKeysEntry({
          removedPaths: unknown.removed,
          originalConfig: originalConfig as Record<string, unknown>,
          trigger,
          version,
        }),
      );
    }
    // Log other changes
    for (const entry of changelogEntries) {
      appendDoctorChangelog(
        buildGenericEntry({
          action: entry.action as
            | "legacy_migration"
            | "legacy_normalization"
            | "plugin_auto_enable",
          changeDescriptions: entry.descriptions,
          trigger,
          version,
        }),
      );
    }
  }

  noteOpencodeProviderOverrides(cfg);

  return { cfg, path: snapshot.path ?? CONFIG_PATH, shouldWriteConfig };
}
