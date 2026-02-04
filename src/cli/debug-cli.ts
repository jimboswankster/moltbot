import type { Command } from "commander";
import { promptSnapshotCommand } from "../commands/debug-prompt-snapshot.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";

export function registerDebugCli(program: Command) {
  const debug = program
    .command("debug")
    .description("Debug and diagnostic tools (opt-in, local only)");

  debug
    .command("prompt-snapshot")
    .description("Capture prompt payload snapshot (dry-run; writes to os/audits/prompt-snapshots)")
    .option("--mode <mode>", "startup | query", "startup")
    .option("--message <text>", "User message for query mode (required when mode=query)")
    .action(async (opts: { mode?: string; message?: string }) => {
      const mode = (opts.mode ?? "startup").toLowerCase();
      if (mode !== "startup" && mode !== "query") {
        defaultRuntime.error("--mode must be 'startup' or 'query'.");
        defaultRuntime.exit(1);
        return;
      }
      await runCommandWithRuntime(defaultRuntime, async () => {
        await promptSnapshotCommand(defaultRuntime, {
          mode: mode as "startup" | "query",
          message: opts.message,
        });
      });
    });
}
