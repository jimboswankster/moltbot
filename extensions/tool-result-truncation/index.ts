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

// ─── Configuration ───

/** Maximum total character length before truncation kicks in. */
const MAX_CONTENT_CHARS = 4_000;

/** Number of characters to keep from the start of oversized content. */
const HEAD_CHARS = 2_000;

/** Number of characters to keep from the end of oversized content. */
const TAIL_CHARS = 500;

/** Marker inserted between head and tail portions. */
const TRUNCATION_MARKER =
  "\n\n[...truncated: content exceeded limit — showing first " +
  `${HEAD_CHARS} and last ${TAIL_CHARS} chars...]\n\n`;

// ─── Truncation logic ───

/**
 * Truncate a single text string using head+tail strategy.
 * Returns the original string if it's within the limit.
 */
function truncateText(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) {
    return text;
  }
  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  return head + TRUNCATION_MARKER + tail;
}

/**
 * Process a message's content array, truncating any oversized text blocks.
 * Non-text blocks (images, etc.) are passed through unchanged.
 */
function truncateMessageContent(content: any[]): any[] {
  return content.map((block: any) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { ...block, text: truncateText(block.text) };
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
    api.on(
      "tool_result_persist",
      (event: any, _ctx: any) => {
        const message = event.message;
        if (!message) return;

        // Only process messages with content arrays
        const content = message.content;
        if (!Array.isArray(content)) return;

        // Check if any text block exceeds the threshold
        const hasOversizedContent = content.some(
          (block: any) =>
            block.type === "text" &&
            typeof block.text === "string" &&
            block.text.length > MAX_CONTENT_CHARS,
        );

        if (!hasOversizedContent) {
          // Nothing to truncate — return undefined to signal no modification
          return;
        }

        // Truncate oversized text blocks, preserving all other message fields
        return {
          message: {
            ...message,
            content: truncateMessageContent(content),
          },
        };
      },
      { priority: 0 },
    );
  },
};

export default toolResultTruncationPlugin;
