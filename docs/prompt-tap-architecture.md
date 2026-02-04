# Prompt Tap — Engine Architecture

**Purpose:** One-shot debug tool that captures the exact prompt payload the model would see (new session or a specific query) and writes it to the workspace for analysis. No provider call; dry-run only.

**Design spec:** See workspace `docs/tool-design/prompt-tap/prompt-tap-and-snapshot-tool.md`.

## CLI

- **Command:** `openclaw debug prompt-snapshot --mode startup|query [--message "..."]`
- **Registration:** Lazy-loaded subcli `debug` in `src/cli/program/register.subclis.ts`; handler in `src/cli/debug-cli.ts`.

## Core Module

- **`src/gateway/prompt-tap.ts`**
  - `runPromptSnapshot({ mode, message? })`: loads config, resolves workspace and default agent, builds system prompt via the same path as the embedded runner (resolveBootstrapContextForRun, buildEmbeddedSystemPrompt with empty tools), assembles payload, writes JSON + MD to `${workspaceDir}/os/audits/prompt-snapshots/<timestamp>-<mode>.*`.
  - Timestamp format: `YYYYMMDDTHHMMSSZ` (filesystem-safe).
  - **workspaceFiles[]:** Built from `contextFiles` (path + byte length of content); included in JSON and as a "Workspace files loaded" table in the MD (path, bytes, total).
  - Markdown sections: Summary, Workspace files loaded (table), [HARNESS SYSTEM], [WORKSPACE SYSTEM — SOUL], [TOOLS], [USER].

## Integration Points

- **Workspace resolution:** `resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg))` (same as other audit/health writers).
- **Prompt construction:** `resolveBootstrapContextForRun`, `buildSystemPromptParams`, `buildEmbeddedSystemPrompt` from agents/pi-embedded-runner — no gateway HTTP path used; CLI builds the prompt directly for snapshot.

## Viewer

Snapshots are read by the workspace viewer only (no engine dependency):

- `pnpm --dir os run prompt:list`
- `pnpm --dir os run prompt:latest [-- --raw] [-- --mode startup|query]`

## Future Refinements

- Optional token counts or per-section length in snapshot metadata.
- If gateway-level tap is added later (e.g. hook after buildAgentPrompt in openresponses-http/openai-http), it can write the same snapshot format to the same directory.
