/**
 * Telegram error classifier — maps internal gateway errors to short,
 * user-friendly messages suitable for Telegram delivery.
 *
 * Used by the hardened dispatch layer (bot-message-dispatch, bot-native-commands)
 * to ensure the user always sees *something* when the agent pipeline fails.
 */

import { isFailoverError } from "../agents/failover-error.js";

const CONTEXT_OVERFLOW_RE = /context.*(overflow|too large|exceeds|token limit)/i;
const COOLDOWN_RE = /all models in cooldown|all.*cooldown|no available auth profile/i;

/**
 * Classify an internal error into a concise user-facing message.
 * The message is short enough for Telegram (< 300 chars) and avoids
 * leaking internal details like API keys, model names, or stack traces.
 */
export function classifyErrorForUser(err: unknown): string {
  if (!err) {
    return "Something went wrong. Please try again.";
  }

  const message = err instanceof Error ? err.message : String(err);

  // AllModelsInCooldownError (thrown by model-fallback.ts)
  if (
    (err instanceof Error && err.name === "AllModelsInCooldownError") ||
    COOLDOWN_RE.test(message)
  ) {
    return (
      "⚠️ All model providers are temporarily unavailable. " +
      "I should recover automatically in a few minutes."
    );
  }

  // FailoverError — classified by reason
  if (isFailoverError(err)) {
    switch (err.reason) {
      case "auth":
        return "⚠️ Authentication issue with the model provider. The owner should check API keys.";
      case "billing":
        return "⚠️ Model provider billing limit reached. Service will resume when credits are replenished.";
      case "rate_limit":
        return "⚠️ Model provider rate limit hit. Please wait a moment and try again.";
      case "timeout":
        return "⚠️ The model took too long to respond. Please try again.";
      case "format":
        return "⚠️ Message format error — the model could not process this input. Try rephrasing.";
      default:
        break;
    }
  }

  // Context overflow (may come as a plain Error, not always FailoverError)
  if (CONTEXT_OVERFLOW_RE.test(message)) {
    return "⚠️ Your message was too large for the current model. Try sending a shorter message.";
  }

  // Generic fallback — avoids leaking internals
  return "⚠️ Something went wrong processing your message. Please try again.";
}
