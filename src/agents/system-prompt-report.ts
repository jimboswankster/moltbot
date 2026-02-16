import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function extractBetween(
  input: string,
  startMarker: string,
  endMarker: string,
): { text: string; found: boolean } {
  const start = input.indexOf(startMarker);
  if (start === -1) {
    return { text: "", found: false };
  }
  const end = input.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    return { text: input.slice(start), found: true };
  }
  return { text: input.slice(start, end), found: true };
}

function parseSkillBlocks(skillsPrompt: string): Array<{ name: string; blockChars: number }> {
  const prompt = skillsPrompt.trim();
  if (!prompt) {
    return [];
  }
  const blocks = Array.from(prompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi)).map(
    (match) => match[0] ?? "",
  );
  return blocks
    .map((block) => {
      const name = block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)";
      return { name, blockChars: block.length };
    })
    .filter((b) => b.blockChars > 0);
}

function buildInjectedWorkspaceFiles(params: {
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  bootstrapMaxChars: number;
}): SessionSystemPromptReport["injectedWorkspaceFiles"] {
  const injectedByName = new Map(params.injectedFiles.map((f) => [f.path, f.content]));
  return params.bootstrapFiles.map((file) => {
    const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
    const injected = injectedByName.get(file.name);
    const injectedChars = injected ? injected.length : 0;
    const truncated = !file.missing && rawChars > params.bootstrapMaxChars;
    return {
      name: file.name,
      path: file.path,
      missing: file.missing,
      rawChars,
      injectedChars,
      truncated,
    };
  });
}

function buildToolsEntries(tools: AgentTool[]): SessionSystemPromptReport["tools"]["entries"] {
  return tools.map((tool) => {
    const name = tool.name;
    const summary = tool.description?.trim() || tool.label?.trim() || "";
    const summaryChars = summary.length;
    const schemaChars = (() => {
      if (!tool.parameters || typeof tool.parameters !== "object") {
        return 0;
      }
      try {
        return JSON.stringify(tool.parameters).length;
      } catch {
        return 0;
      }
    })();
    const propertiesCount = (() => {
      const schema =
        tool.parameters && typeof tool.parameters === "object"
          ? (tool.parameters as Record<string, unknown>)
          : null;
      const props = schema && typeof schema.properties === "object" ? schema.properties : null;
      if (!props || typeof props !== "object") {
        return null;
      }
      return Object.keys(props as Record<string, unknown>).length;
    })();
    return { name, summaryChars, schemaChars, propertiesCount };
  });
}

function extractToolListText(systemPrompt: string): string {
  const markerA = "Tool names are case-sensitive. Call tools exactly as listed.\n";
  const markerB =
    "\nTOOLS.md does not control tool availability; it is user guidance for how to use external tools.";
  const extracted = extractBetween(systemPrompt, markerA, markerB);
  if (!extracted.found) {
    return "";
  }
  return extracted.text.replace(markerA, "").trim();
}

type PromptSection = {
  name: string;
  category: string;
  chars: number;
};

function normalizeHeaderName(header: string): string {
  return header
    .replace(/\([^)]*\)/g, "")
    .replace(/[:.]+$/g, "")
    .trim()
    .toLowerCase();
}

function mapHeaderToCategory(header: string): string {
  const normalized = normalizeHeaderName(header);
  if (!normalized) {
    return "unmapped";
  }
  if (normalized === "project context") return "optional_context";
  if (normalized === "runtime") return "core_identity";

  const toolInventory = new Set([
    "tooling",
    "tool call style",
    "openclaw cli quick reference",
    "openclaw self-update",
    "model aliases",
  ]);
  if (toolInventory.has(normalized)) return "tool_inventory";

  const protocolHarness = new Set([
    "safety",
    "skills",
    "memory recall",
    "reply tags",
    "messaging",
    "voice",
    "reactions",
    "reasoning format",
    "silent replies",
    "heartbeats",
  ]);
  if (protocolHarness.has(normalized)) return "protocol_harness";

  const taskEnvelope = new Set([
    "workspace",
    "documentation",
    "sandbox",
    "user identity",
    "current date & time",
    "workspace files",
    "group chat context",
    "subagent context",
  ]);
  if (taskEnvelope.has(normalized)) return "task_envelope";

  return "unmapped";
}

function buildPromptSections(systemPrompt: string): PromptSection[] {
  const lines = systemPrompt.split(/\r?\n/);
  const sections: Array<{ name: string; lines: string[]; category: string }> = [];
  let currentName = "(preamble)";
  let currentLines: string[] = [];
  let currentCategory = "core_identity";
  let inProjectContext = false;

  const flush = () => {
    const text = currentLines.join("\n");
    if (text.trim().length === 0) {
      currentLines = [];
      return;
    }
    sections.push({
      name: currentName,
      lines: currentLines,
      category: currentCategory,
    });
    currentLines = [];
  };

  const projectContextExitHeaders = new Set(["silent replies", "heartbeats", "runtime"]);

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,2})\s+(.*)$/);
    if (!headerMatch) {
      currentLines.push(line);
      continue;
    }
    const headerName = headerMatch[2]?.trim() || "(unknown)";
    const normalizedHeader = normalizeHeaderName(headerName);
    if (inProjectContext && !projectContextExitHeaders.has(normalizedHeader)) {
      currentLines.push(line);
      continue;
    }

    flush();
    currentName = headerName;
    currentCategory = mapHeaderToCategory(headerName);
    inProjectContext = normalizedHeader === "project context";
    currentLines.push(line);
  }

  flush();

  return sections.map((section) => ({
    name: section.name,
    category: section.category,
    chars: section.lines.join("\n").length,
  }));
}

function buildPromptBudgetReport(params: {
  systemPrompt: string;
  promptBudgetPlan?: SessionSystemPromptReport["hydration"]["promptBudgetPlan"];
}): SessionSystemPromptReport["promptBudgetReport"] | undefined {
  const promptBudgetPlan = params.promptBudgetPlan;
  const budgets = promptBudgetPlan?.budgets ?? {};
  const sections = buildPromptSections(params.systemPrompt);
  const totalsByCategory = new Map<string, number>();
  for (const section of sections) {
    totalsByCategory.set(
      section.category,
      (totalsByCategory.get(section.category) ?? 0) + section.chars,
    );
  }

  const orderedCategories = [
    "core_identity",
    "protocol_harness",
    "task_envelope",
    "tool_inventory",
    "optional_context",
    "unmapped",
  ];
  const totals = orderedCategories
    .filter((category) => totalsByCategory.has(category))
    .map((category) => {
      const chars = totalsByCategory.get(category) ?? 0;
      const budget = budgets[category];
      const overBy = budget !== undefined ? Math.max(0, chars - budget) : undefined;
      return {
        category,
        chars,
        budget,
        overBy,
      };
    });

  return {
    profile: promptBudgetPlan?.profile,
    totals,
    sections: sections.map((section) => ({
      name: section.name,
      category: section.category,
      chars: section.chars,
    })),
  };
}

export function buildSystemPromptReport(params: {
  source: SessionSystemPromptReport["source"];
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  hydration?: SessionSystemPromptReport["hydration"];
  bootstrapMaxChars: number;
  sandbox?: SessionSystemPromptReport["sandbox"];
  systemPrompt: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  skillsPrompt: string;
  tools: AgentTool[];
}): SessionSystemPromptReport {
  const systemPrompt = params.systemPrompt.trim();
  const projectContext = extractBetween(
    systemPrompt,
    "\n# Project Context\n",
    "\n## Silent Replies\n",
  );
  const projectContextChars = projectContext.text.length;
  const toolListText = extractToolListText(systemPrompt);
  const toolListChars = toolListText.length;
  const toolsEntries = buildToolsEntries(params.tools);
  const toolsSchemaChars = toolsEntries.reduce((sum, t) => sum + (t.schemaChars ?? 0), 0);
  const skillsEntries = parseSkillBlocks(params.skillsPrompt);
  const promptBudgetReport = buildPromptBudgetReport({
    systemPrompt,
    promptBudgetPlan: params.hydration?.promptBudgetPlan,
  });

  return {
    source: params.source,
    generatedAt: params.generatedAt,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.model,
    workspaceDir: params.workspaceDir,
    hydration: params.hydration,
    bootstrapMaxChars: params.bootstrapMaxChars,
    sandbox: params.sandbox,
    systemPrompt: {
      chars: systemPrompt.length,
      projectContextChars,
      nonProjectContextChars: Math.max(0, systemPrompt.length - projectContextChars),
    },
    injectedWorkspaceFiles: buildInjectedWorkspaceFiles({
      bootstrapFiles: params.bootstrapFiles,
      injectedFiles: params.injectedFiles,
      bootstrapMaxChars: params.bootstrapMaxChars,
    }),
    skills: {
      promptChars: params.skillsPrompt.length,
      entries: skillsEntries,
    },
    tools: {
      listChars: toolListChars,
      schemaChars: toolsSchemaChars,
      entries: toolsEntries,
    },
    promptBudgetReport,
  };
}
