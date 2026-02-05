export const TRANSITIONAL_A2A_INBOX_TAG = "TRANSITIONAL_A2A_INBOX";

export type A2AInboxEvent = {
  schemaVersion: 1;
  createdAt: number;
  runId: string;
  sourceSessionKey: string;
  sourceDisplayKey?: string;
  replyText: string;
  deliveredAt?: number;
  deliveredRunId?: string;
};

export type A2AInboxPromptBlockResult = {
  text: string;
  includedRunIds: string[];
  truncated: boolean;
};

export function buildA2AInboxPromptBlock(params: {
  events: A2AInboxEvent[];
  maxEvents: number;
  maxChars: number;
}): A2AInboxPromptBlockResult {
  const events = params.events
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId));
  const selected = events.slice(0, Math.max(0, params.maxEvents));

  let text = TRANSITIONAL_A2A_INBOX_TAG;
  let remaining = Math.max(0, params.maxChars - text.length);
  const includedRunIds: string[] = [];
  let truncated = false;

  for (const event of selected) {
    const display = event.sourceDisplayKey?.trim() || event.sourceSessionKey;
    const header = `\n- source: ${display} (${event.sourceSessionKey})\n  runId: ${event.runId}\n  text: `;
    if (header.length > remaining) {
      truncated = true;
      break;
    }
    text += header;
    remaining -= header.length;

    if (event.replyText.length > remaining) {
      const sliceLen = Math.max(0, remaining - 3);
      text += `${event.replyText.slice(0, sliceLen)}...`;
      truncated = true;
      remaining = 0;
      includedRunIds.push(event.runId);
      break;
    }

    text += event.replyText;
    remaining -= event.replyText.length;
    includedRunIds.push(event.runId);
  }

  return { text, includedRunIds, truncated };
}
