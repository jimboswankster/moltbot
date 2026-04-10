import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type ImmediateMemoryReuseConfig = {
  storageSubdir: string;
  maxFactChars: number;
  maxAgeMs: number;
};

type PluginApiLike = {
  pluginConfig?: unknown;
  logger: {
    info?: (message: string) => void;
    warn: (message: string) => void;
    debug?: (message: string) => void;
  };
  on: (
    hookName: "before_agent_start" | "agent_end",
    handler: (event: unknown, ctx: { workspaceDir?: string; sessionKey?: string }) => unknown,
  ) => void;
};

type FactSidecar = {
  schema_version: "openclaw.immediate-memory-reuse.v1";
  sessionKey: string;
  createdAt: string;
  fact: string;
  sourceSnippet: string;
};

const DEFAULT_STORAGE_SUBDIR = path.join(".openclaw", "surface-3-memory");
const DEFAULT_MAX_FACT_CHARS = 160;
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

const configSchema = {
  parse(value: unknown): ImmediateMemoryReuseConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    const storageSubdir =
      typeof raw.storageSubdir === "string" && raw.storageSubdir.trim()
        ? raw.storageSubdir.trim()
        : DEFAULT_STORAGE_SUBDIR;
    const maxFactChars =
      typeof raw.maxFactChars === "number" &&
      Number.isInteger(raw.maxFactChars) &&
      raw.maxFactChars > 0
        ? raw.maxFactChars
        : DEFAULT_MAX_FACT_CHARS;
    const maxAgeMs =
      typeof raw.maxAgeMs === "number" && Number.isInteger(raw.maxAgeMs) && raw.maxAgeMs > 0
        ? raw.maxAgeMs
        : DEFAULT_MAX_AGE_MS;

    return { storageSubdir, maxFactChars, maxAgeMs };
  },
  uiHints: {
    storageSubdir: {
      label: "Storage Subdirectory",
      help: "Workspace-relative location for one-turn immediate-memory sidecars.",
      advanced: true,
    },
    maxFactChars: {
      label: "Max Fact Characters",
      help: "Maximum length of the stored compact fact.",
      advanced: true,
    },
    maxAgeMs: {
      label: "Max Fact Age (ms)",
      help: "Expire pending immediate-memory facts after this many milliseconds.",
      advanced: true,
    },
  },
};

const FACT_RULES: Array<{ pattern: RegExp; fact: string }> = [
  {
    pattern: /(pnpm-lock\.yaml|packageManager["'\s:=-]*pnpm|\bpnpm\b)/i,
    fact: "Repo entrypoint fact: use pnpm-aware commands for the immediate next step.",
  },
  {
    pattern: /(bun\.lockb|packageManager["'\s:=-]*bun|\bbun\b)/i,
    fact: "Repo entrypoint fact: use bun-aware commands for the immediate next step.",
  },
  {
    pattern: /(yarn\.lock|packageManager["'\s:=-]*yarn|\byarn\b)/i,
    fact: "Repo entrypoint fact: use yarn-aware commands for the immediate next step.",
  },
  {
    pattern: /(package\.json|\bnpm\b)/i,
    fact: "Repo entrypoint fact: use Node/package.json-aware commands for the immediate next step.",
  },
  {
    pattern: /(uv\.lock|\buv\b|pyproject\.toml)/i,
    fact: "Repo entrypoint fact: use Python project commands and avoid rechecking the repo type immediately.",
  },
  {
    pattern: /(Cargo\.toml|\bcargo\b)/i,
    fact: "Repo entrypoint fact: use cargo-aware commands for the immediate next step.",
  },
  {
    pattern: /(go\.mod|\bgo test\b|\bgo build\b)/i,
    fact: "Repo entrypoint fact: use Go module commands for the immediate next step.",
  },
];

function buildSidecarPath(workspaceDir: string, sessionKey: string, storageSubdir: string): string {
  const sessionHash = createHash("sha1").update(sessionKey).digest("hex");
  return path.join(workspaceDir, storageSubdir, `${sessionHash}.json`);
}

function clipText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function extractTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const blocks: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as Record<string, unknown>).type === "text" &&
      "text" in block &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      blocks.push((block as Record<string, unknown>).text as string);
    }
  }
  return blocks;
}

export function extractImmediateReuseFact(
  messages: unknown[],
  maxFactChars = DEFAULT_MAX_FACT_CHARS,
): { fact: string; sourceSnippet: string } | null {
  const texts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const content = (message as Record<string, unknown>).content;
    texts.push(...extractTextBlocks(content));
  }

  for (const text of texts.toReversed()) {
    for (const rule of FACT_RULES) {
      if (rule.pattern.test(text)) {
        return {
          fact: clipText(rule.fact, maxFactChars),
          sourceSnippet: clipText(text.replace(/\s+/g, " ").trim(), maxFactChars),
        };
      }
    }
  }

  return null;
}

async function writeSidecar(params: {
  workspaceDir: string;
  sessionKey: string;
  config: ImmediateMemoryReuseConfig;
  sidecar: FactSidecar;
}) {
  const sidecarPath = buildSidecarPath(
    params.workspaceDir,
    params.sessionKey,
    params.config.storageSubdir,
  );
  await fs.mkdir(path.dirname(sidecarPath), { recursive: true });
  await fs.writeFile(sidecarPath, JSON.stringify(params.sidecar, null, 2), "utf-8");
}

async function readSidecar(params: {
  workspaceDir: string;
  sessionKey: string;
  config: ImmediateMemoryReuseConfig;
}): Promise<FactSidecar | null> {
  const sidecarPath = buildSidecarPath(
    params.workspaceDir,
    params.sessionKey,
    params.config.storageSubdir,
  );
  try {
    const raw = await fs.readFile(sidecarPath, "utf-8");
    return JSON.parse(raw) as FactSidecar;
  } catch {
    return null;
  }
}

async function consumeSidecar(params: {
  workspaceDir: string;
  sessionKey: string;
  config: ImmediateMemoryReuseConfig;
}): Promise<void> {
  const sidecarPath = buildSidecarPath(
    params.workspaceDir,
    params.sessionKey,
    params.config.storageSubdir,
  );
  await fs.rm(sidecarPath, { force: true });
}

function isExpired(createdAt: string, maxAgeMs: number): boolean {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    return true;
  }
  return Date.now() - timestamp > maxAgeMs;
}

function buildPrependContext(fact: string): string {
  return [
    "<immediate-memory-reuse>",
    "Immediate prior-turn harness fact:",
    `- ${fact}`,
    "Use this to avoid repeating the same repo-entry discovery unless new evidence contradicts it.",
    "</immediate-memory-reuse>",
  ].join("\n");
}

const immediateMemoryReusePlugin = {
  id: "immediate-memory-reuse",
  name: "Immediate Memory Reuse",
  description: "Stores one compact repo-entry fact at run end and reuses it on the immediate next run.",
  configSchema,
  register(api: PluginApiLike) {
    const config = configSchema.parse(api.pluginConfig);

    api.on("agent_end", async (event, ctx) => {
      if (!ctx.workspaceDir || !ctx.sessionKey) {
        return;
      }
      if (!event || typeof event !== "object") {
        return;
      }
      const eventRecord = event as Record<string, unknown>;
      if (eventRecord.success !== true || !Array.isArray(eventRecord.messages)) {
        return;
      }

      const extracted = extractImmediateReuseFact(eventRecord.messages, config.maxFactChars);
      if (!extracted) {
        return;
      }

      await writeSidecar({
        workspaceDir: ctx.workspaceDir,
        sessionKey: ctx.sessionKey,
        config,
        sidecar: {
          schema_version: "openclaw.immediate-memory-reuse.v1",
          sessionKey: ctx.sessionKey,
          createdAt: new Date().toISOString(),
          fact: extracted.fact,
          sourceSnippet: extracted.sourceSnippet,
        },
      });
      api.logger.info?.("immediate-memory-reuse: wrote pending next-turn fact");
    });

    api.on("before_agent_start", async (_event, ctx) => {
      if (!ctx.workspaceDir || !ctx.sessionKey) {
        return;
      }

      const sidecar = await readSidecar({
        workspaceDir: ctx.workspaceDir,
        sessionKey: ctx.sessionKey,
        config,
      });
      if (!sidecar) {
        return;
      }
      if (isExpired(sidecar.createdAt, config.maxAgeMs)) {
        await consumeSidecar({
          workspaceDir: ctx.workspaceDir,
          sessionKey: ctx.sessionKey,
          config,
        });
        api.logger.debug?.("immediate-memory-reuse: dropped stale next-turn fact");
        return;
      }

      await consumeSidecar({
        workspaceDir: ctx.workspaceDir,
        sessionKey: ctx.sessionKey,
        config,
      });
      api.logger.info?.("immediate-memory-reuse: injected pending next-turn fact");
      return {
        prependContext: buildPrependContext(sidecar.fact),
      };
    });
  },
};

export default immediateMemoryReusePlugin;
