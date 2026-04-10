/**
 * Tool Result Truncation Plugin
 *
 * Prevents context explosion (P0-CE Fix 2) by truncating large tool results
 * before they are persisted to the session transcript. Without this plugin,
 * tool results (50K+ chars) are stored verbatim and replayed on every LLM
 * call, causing O(N²) context growth and runaway API costs.
 *
 * **Enabled by default** — this is a safety-critical plugin listed in
 * BUNDLED_ENABLED_BY_DEFAULT (src/plugins/config-state.ts). To disable:
 *   plugins.entries.tool-result-truncation.enabled: false
 *
 * Strategy: head+tail truncation. Keeps the first HEAD_CHARS and last
 * TAIL_CHARS of each text block, with a truncation marker in between.
 * This preserves diagnostic value (errors often appear at the start or
 * end of output) while capping the persisted size.
 *
 * Hook: tool_result_persist (synchronous, runs in appendMessage hot path)
 * Priority: 0 (default — runs after any higher-priority plugin transforms)
 *
 * @see src/agents/session-tool-result-guard-wrapper.ts — wiring
 * @see src/plugins/hooks.ts — hook runner (runToolResultPersist)
 * @see src/plugins/config-state.ts — BUNDLED_ENABLED_BY_DEFAULT
 * @see docs/concepts/agent-loop.md — hook lifecycle documentation
 * @see E-004 audit: workspace/docs/development/debug/subagent-pipeline/audits/README.md
 */

type TruncationVariantId = "incumbent" | "diagnostic-signal-tight-marker";

type TruncationVariant = {
  maxContentChars: number;
  headChars: number;
  tailChars: number;
  marker: string;
};

type ToolResultTruncationConfig = {
  variantId: TruncationVariantId;
  allowedWorkspacePrefixes: string[];
};

type ToolResultPersistContext = {
  workspaceDir?: string;
};

const INCUMBENT_VARIANT: TruncationVariant = {
  maxContentChars: 4_000,
  headChars: 2_000,
  tailChars: 500,
  marker:
    "\n\n[...truncated: content exceeded limit — showing first 2000 and last 500 chars...]\n\n",
};

const DIAGNOSTIC_SIGNAL_TIGHT_MARKER_VARIANT: TruncationVariant = {
  maxContentChars: 2_200,
  headChars: 1_000,
  tailChars: 260,
  marker: "\n\n[...trimmed...]\n\n",
};

const DEFAULT_CONFIG: ToolResultTruncationConfig = {
  variantId: "incumbent",
  allowedWorkspacePrefixes: [],
};

function parseConfig(raw: unknown): ToolResultTruncationConfig {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const variantId =
    value.variantId === "diagnostic-signal-tight-marker" ? value.variantId : DEFAULT_CONFIG.variantId;
  const allowedWorkspacePrefixes = Array.isArray(value.allowedWorkspacePrefixes)
    ? value.allowedWorkspacePrefixes
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : DEFAULT_CONFIG.allowedWorkspacePrefixes;

  return {
    variantId,
    allowedWorkspacePrefixes,
  };
}

function isAllowedWorkspaceDir(workspaceDir: string, allowPrefixes: string[]): boolean {
  if (allowPrefixes.length === 0) {
    return false;
  }
  return allowPrefixes.some((prefix) => workspaceDir.startsWith(prefix));
}

function resolveVariant(
  config: ToolResultTruncationConfig,
  ctx: ToolResultPersistContext,
): TruncationVariant {
  if (config.variantId !== "diagnostic-signal-tight-marker") {
    return INCUMBENT_VARIANT;
  }
  if (!ctx.workspaceDir || !isAllowedWorkspaceDir(ctx.workspaceDir, config.allowedWorkspacePrefixes)) {
    return INCUMBENT_VARIANT;
  }
  return DIAGNOSTIC_SIGNAL_TIGHT_MARKER_VARIANT;
}

// ─── Truncation logic ───

/**
 * Truncate a single text string using head+tail strategy.
 * Returns the original string if it's within the limit.
 */
function truncateText(text: string, variant: TruncationVariant): string {
  if (text.length <= variant.maxContentChars) {
    return text;
  }
  const head = text.slice(0, variant.headChars);
  const tail = text.slice(-variant.tailChars);
  return head + variant.marker + tail;
}

/**
 * Process a message's content array, truncating any oversized text blocks.
 * Non-text blocks (images, etc.) are passed through unchanged.
 */
function truncateMessageContent(content: any[], variant: TruncationVariant): any[] {
  return content.map((block: any) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { ...block, text: truncateText(block.text, variant) };
    }
    return block;
  });
}

// ─── Plugin definition ───

const toolResultTruncationPlugin = {
  id: "tool-result-truncation",
  name: "Tool Result Truncation",
  description:
    "Truncates large tool results before session persistence to prevent context explosion",

  register(api: any) {
    const config = parseConfig(api.pluginConfig);
    if (config.variantId !== "incumbent" && config.allowedWorkspacePrefixes.length === 0) {
      api.logger?.warn?.(
        "tool-result-truncation: candidate variant configured without allowedWorkspacePrefixes; preserving incumbent behavior",
      );
    }
    api.on(
      "tool_result_persist",
      (event: any, ctx: ToolResultPersistContext) => {
        const message = event.message;
        if (!message) return;

        // Only process messages with content arrays
        const content = message.content;
        if (!Array.isArray(content)) return;

        const variant = resolveVariant(config, ctx ?? {});

        // Check if any text block exceeds the threshold
        const hasOversizedContent = content.some(
          (block: any) =>
            block.type === "text" &&
            typeof block.text === "string" &&
            block.text.length > variant.maxContentChars,
        );

        if (!hasOversizedContent) {
          // Nothing to truncate — return undefined to signal no modification
          return;
        }

        // Truncate oversized text blocks, preserving all other message fields
        return {
          message: {
            ...message,
            content: truncateMessageContent(content, variant),
          },
        };
      },
      { priority: 0 },
    );
  },
};

export default toolResultTruncationPlugin;
