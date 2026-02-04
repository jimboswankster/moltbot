/**
 * CLI command: openclaw debug prompt-snapshot --mode startup|query [--message "..."]
 * Captures the prompt payload the model would see and writes snapshot files to
 * os/audits/prompt-snapshots/ (dry-run; does not call the provider).
 */

import type { RuntimeEnv } from "../runtime.js";
import { runPromptSnapshot } from "../gateway/prompt-tap.js";
import { theme } from "../terminal/theme.js";

export type PromptSnapshotCommandOptions = {
  mode: "startup" | "query";
  message?: string;
};

export async function promptSnapshotCommand(
  runtime: RuntimeEnv,
  opts: PromptSnapshotCommandOptions,
): Promise<void> {
  if (opts.mode === "query" && (opts.message == null || String(opts.message).trim() === "")) {
    runtime.error("When --mode is query, --message is required.");
    runtime.exit(1);
    return;
  }

  try {
    const result = await runPromptSnapshot({
      mode: opts.mode,
      message: opts.mode === "query" ? opts.message : undefined,
    });

    runtime.log(
      theme.success(
        `Prompt snapshot written (mode: ${result.ok ? opts.mode : "?"}, dry-run; provider not called).`,
      ),
    );
    runtime.log(theme.muted(`  Base: ${result.baseName}`));
    runtime.log(theme.muted(`  Dir:  ${result.snapshotDir}`));
    runtime.log(
      theme.muted(`  View: pnpm --dir os run prompt:latest (or prompt:list) from the workspace.`),
    );
  } catch (err) {
    runtime.error(String(err instanceof Error ? err.message : err));
    runtime.exit(1);
  }
}
