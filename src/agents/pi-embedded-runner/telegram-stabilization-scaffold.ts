import type { OpenClawConfig } from "../../config/config.js";

export type TelegramStabilizationScaffold = {
  id: string;
  taskClass: "telegram-codex-stabilization";
  preferredFirstStep: string[];
  secondary: string[];
  contextual: string[];
};

export type TelegramStabilizationToolUseGuardMode = "off" | "diagnostic" | "enforce";

const TELEGRAM_FEDERATED_MASTER_SCAFFOLD: TelegramStabilizationScaffold = {
  id: "telegram_federated_master",
  taskClass: "telegram-codex-stabilization",
  preferredFirstStep: ["read", "exec", "sessions_history", "session_status", "message"],
  secondary: [
    "write",
    "edit",
    "apply_patch",
    "web_search",
    "web_fetch",
    "browser",
    "cron",
    "gateway",
    "sessions_spawn",
  ],
  contextual: ["channel_agent_tools", "plugin_tools", "image", "tts", "canvas"],
};

export function resolveTelegramStabilizationScaffold(
  trustedTaskClass?: string | null,
): TelegramStabilizationScaffold | null {
  if (trustedTaskClass !== "telegram-codex-stabilization") {
    return null;
  }
  return TELEGRAM_FEDERATED_MASTER_SCAFFOLD;
}

export function resolveTelegramStabilizationToolUseGuardMode(params: {
  config?: OpenClawConfig;
  trustedTaskClass?: string | null;
}): TelegramStabilizationToolUseGuardMode {
  if (params.trustedTaskClass !== "telegram-codex-stabilization") {
    return "off";
  }
  return params.config?.agents?.defaults?.telegramStabilization?.toolUseGuardMode ?? "diagnostic";
}

export function buildTelegramStabilizationRepairPrompt(
  scaffold: TelegramStabilizationScaffold,
): string {
  const preferred = scaffold.preferredFirstStep.map((tool) => `\`${tool}\``).join(", ");
  const secondary = scaffold.secondary.map((tool) => `\`${tool}\``).join(", ");
  return (
    "\n\nSYSTEM REPAIR REQUIREMENT: This Telegram stabilization turn requires real tool activity before any final reply. " +
    "Your previous attempt failed because it did not produce a usable tool-backed result. " +
    `For this retry, start with one preferred first-step tool: ${preferred}. ` +
    "Do one concrete inspection or verification step before any narrative response. " +
    "If you need additional tools after that first step, you may then use secondary tools. " +
    `Secondary tools: ${secondary}. ` +
    "Do not answer conversationally before taking that first tool-backed step. " +
    "Only after tool activity, return the final operator-facing reply grounded in those tool results."
  );
}

export function isTelegramStabilizationPreferredFirstStepTool(
  scaffold: TelegramStabilizationScaffold | null,
  toolName?: string | null,
): boolean | null {
  if (!scaffold) {
    return null;
  }
  const normalized = toolName?.trim();
  if (!normalized) {
    return null;
  }
  return scaffold.preferredFirstStep.includes(normalized);
}
