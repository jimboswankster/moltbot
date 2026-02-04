export type SlashCommand = {
  name: string;
  summary: string;
};

export const slashCommands: SlashCommand[] = [
  { name: "/commands", summary: "Show available slash commands and what they do." },
  {
    name: "/commit",
    summary: "Run the commit protocol (recall GIT_POLICY.md, then stage/commit).",
  },
  { name: "/global_readme", summary: "Read the global workspace README and route." },
  { name: "/global_changelog", summary: "Open/update SYSTEM_CHANGELOG.md." },
  { name: "/os_changelog", summary: "Open the OS-level changelog in Second Brain." },
  { name: "/local_changelog", summary: "Open the changelog for the current project/system." },
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
