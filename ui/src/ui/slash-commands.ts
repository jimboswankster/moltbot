export type SlashCommand = {
  name: string;
  summary: string;
  prompt?: string;
};

export const slashCommands: SlashCommand[] = [
  {
    name: "/commands",
    summary: "Show available slash commands and what they do.",
    prompt:
      "List the available slash commands you support in this workspace and briefly explain what each one does.",
  },
  {
    name: "/commit",
    summary: "Run the commit protocol (recall GIT_POLICY.md, then stage/commit).",
    prompt:
      "Commit your work according to our git policy. Recall GIT_POLICY.md, run git status, and proceed with an appropriate commit plan.",
  },
  {
    name: "/global_readme",
    summary: "Read the global workspace README and route.",
    prompt:
      "Read the global workspace README (README.md at the workspace root) and use it as the router.",
  },
  {
    name: "/global_changelog",
    summary: "Open/update SYSTEM_CHANGELOG.md.",
    prompt: "Open SYSTEM_CHANGELOG.md at the workspace root and summarize the most recent entries.",
  },
  {
    name: "/os_changelog",
    summary: "Open the OS-level changelog in Second Brain.",
    prompt:
      "Open the OS-level changelog in Second Brain (os/vault/projects/second-brain/CHANGELOG.md) and summarize recent entries.",
  },
  {
    name: "/local_changelog",
    summary: "Open the changelog for the current project/system.",
    prompt:
      "Determine the current project or system context and open the relevant local changelog, then summarize recent entries.",
  },
];

export function filterSlashCommands(
  query: string,
  commands: SlashCommand[] = slashCommands,
): SlashCommand[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return commands;
  }
  return commands.filter((cmd) => cmd.name.toLowerCase().startsWith(`/${normalized}`));
}

export async function loadSlashCommands(basePath: string): Promise<SlashCommand[]> {
  const base = basePath.trim();
  const url = `${base ? base.replace(/\/$/, "") : ""}/commands`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      return slashCommands;
    }
    const payload = (await res.json()) as { commands?: Array<Record<string, unknown>> };
    const entries = Array.isArray(payload?.commands) ? payload.commands : [];
    const mapped = entries
      .map((entry) => ({
        name: typeof entry.slash === "string" ? entry.slash.trim() : "",
        summary:
          (typeof entry.label === "string" && entry.label.trim()) ||
          (typeof entry.id === "string" ? entry.id.trim() : ""),
        prompt: typeof entry.prompt === "string" ? entry.prompt : undefined,
      }))
      .filter((entry) => entry.name);
    return mapped.length > 0 ? mapped : slashCommands;
  } catch {
    return slashCommands;
  }
}
