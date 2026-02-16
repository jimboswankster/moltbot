import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

type ProtocolIndexEntry = {
  id: string;
  path: string;
  hydration_profile?: string;
  agent_role?: string;
  context_policy?: string;
};

type ProtocolIndex = {
  protocols?: ProtocolIndexEntry[];
};

export type HydrationProfileResolution = {
  hydrationProfile?: string;
  agentRole?: string;
  contextPolicy?: string;
  protocolRefs: string[];
  matchedProtocols: string[];
};

export type PromptBudgetManifest = {
  sections: Record<string, { label?: string; never_drop?: boolean }>;
  shrink_order: string[];
  profiles: Record<string, { budgets_chars: Record<string, number> }>;
};

export type PromptBudgetResolution = {
  profile?: string;
  budgets?: Record<string, number>;
  shrinkOrder?: string[];
  neverDrop?: string[];
};

type CachedIndex = {
  mtimeMs: number;
  index: ProtocolIndexEntry[];
};

const indexCache = new Map<string, CachedIndex>();

function extractTextFromMessage(message: AgentMessage): string[] {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return [content];
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        const text = (block as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter((text) => text.length > 0);
  }
  return [];
}

function parseProtocolRefs(messages: AgentMessage[]): string[] {
  const refs = new Set<string>();
  for (const message of messages) {
    const chunks = extractTextFromMessage(message);
    for (const chunk of chunks) {
      const matches = chunk.match(/PROTOCOL:\s*([^\n\r]+)/g) ?? [];
      for (const match of matches) {
        const ref = match.replace(/^PROTOCOL:\s*/i, "").trim();
        if (ref) refs.add(ref);
      }
    }
  }
  return Array.from(refs);
}

function loadProtocolIndex(workspaceDir: string): ProtocolIndexEntry[] {
  const indexPath = path.join(workspaceDir, "os", "protocols", "protocol-index.yaml");
  if (!fs.existsSync(indexPath)) {
    return [];
  }
  const stat = fs.statSync(indexPath);
  const cached = indexCache.get(indexPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.index;
  }
  const raw = fs.readFileSync(indexPath, "utf-8");
  const parsed = YAML.parse(raw) as ProtocolIndex | null;
  const protocols = Array.isArray(parsed?.protocols) ? parsed?.protocols : [];
  const normalized = protocols
    .map((entry) => ({
      id: String(entry.id ?? ""),
      path: String(entry.path ?? ""),
      hydration_profile:
        typeof entry.hydration_profile === "string" ? entry.hydration_profile : undefined,
      agent_role: typeof entry.agent_role === "string" ? entry.agent_role : undefined,
      context_policy: typeof entry.context_policy === "string" ? entry.context_policy : undefined,
    }))
    .filter((entry) => entry.path.length > 0);
  indexCache.set(indexPath, { mtimeMs: stat.mtimeMs, index: normalized });
  return normalized;
}

function contextPolicyRank(policy?: string): number {
  switch (policy) {
    case "artifact_only":
      return 3;
    case "bounded":
      return 2;
    case "full":
      return 1;
    default:
      return 0;
  }
}

export function resolveHydrationProfile(params: {
  messages: AgentMessage[];
  workspaceDir?: string;
}): HydrationProfileResolution | undefined {
  if (!params.workspaceDir) return undefined;
  const protocolRefs = parseProtocolRefs(params.messages);
  if (protocolRefs.length === 0) {
    return { protocolRefs, matchedProtocols: [] };
  }
  const index = loadProtocolIndex(params.workspaceDir);
  if (index.length === 0) {
    return { protocolRefs, matchedProtocols: [] };
  }
  const matches = index.filter((entry) => protocolRefs.includes(entry.path));
  if (matches.length === 0) {
    return { protocolRefs, matchedProtocols: [] };
  }
  const selected = matches
    .slice()
    .sort((a, b) => contextPolicyRank(b.context_policy) - contextPolicyRank(a.context_policy))[0];
  return {
    hydrationProfile: selected.hydration_profile,
    agentRole: selected.agent_role,
    contextPolicy: selected.context_policy,
    protocolRefs,
    matchedProtocols: matches.map((entry) => entry.path),
  };
}

function loadBudgetManifest(workspaceDir: string): PromptBudgetManifest | null {
  const manifestPath = path.join(
    workspaceDir,
    "os",
    "vault",
    "systems",
    "llm-runtime-optimization",
    "prompt-assembly-budgets.yaml",
  );
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const raw = fs.readFileSync(manifestPath, "utf-8");
  const parsed = YAML.parse(raw) as PromptBudgetManifest | null;
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  return parsed;
}

export function resolvePromptBudgetPlan(params: {
  workspaceDir?: string;
  hydrationProfile?: string;
}): PromptBudgetResolution | undefined {
  if (!params.workspaceDir || !params.hydrationProfile) {
    return undefined;
  }
  const manifest = loadBudgetManifest(params.workspaceDir);
  if (!manifest) {
    return undefined;
  }
  const profile = manifest.profiles?.[params.hydrationProfile];
  if (!profile) {
    return undefined;
  }
  const neverDrop = Object.entries(manifest.sections ?? {})
    .filter(([, info]) => Boolean(info?.never_drop))
    .map(([key]) => key);
  return {
    profile: params.hydrationProfile,
    budgets: profile.budgets_chars,
    shrinkOrder: manifest.shrink_order ?? [],
    neverDrop,
  };
}
