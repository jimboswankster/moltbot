import fs from "node:fs";
import path from "node:path";
import { parseIdentityMarkdown } from "../../agents/identity-file.js";
import { DEFAULT_USER_FILENAME, DEFAULT_IDENTITY_FILENAME } from "../../agents/workspace.js";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";

/**
 * Reads USER.md and IDENTITY.md from a workspace directory and returns
 * a Map<chatId, displayName> for Telegram directory supplementation.
 *
 * This replaces static name config in openclaw.json with dynamic,
 * file-driven identity resolution.
 */
export function loadWorkspaceTelegramPeers(workspaceDir: string): Map<string, string> {
  const peers = new Map<string, string>();

  // --- USER.md: extract name + telegram_chat_id from YAML frontmatter ---
  try {
    const userPath = path.join(workspaceDir, DEFAULT_USER_FILENAME);
    const userContent = fs.readFileSync(userPath, "utf-8");
    const fm = parseFrontmatterBlock(userContent);

    const name = fm.name?.trim() || fm.call_me?.trim();
    const chatId = fm.telegram_chat_id?.trim();

    if (name && chatId) {
      peers.set(chatId, name);
      console.log(`[workspace-identity] loaded user peer from USER.md: ${name} → ${chatId}`);
    } else if (name && !chatId) {
      console.warn(
        `[workspace-identity] USER.md has name="${name}" but no telegram_chat_id — skipping Telegram peer`,
      );
    }
  } catch (err) {
    // USER.md may not exist or may not be readable; that's fine.
    console.warn(
      `[workspace-identity] could not read USER.md from ${workspaceDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return peers;
}

/**
 * Reads the agent name from IDENTITY.md using the full parsing chain
 * (YAML frontmatter with body fallback via parseIdentityMarkdown).
 * Returns the name string or undefined.
 */
export function loadWorkspaceAgentName(workspaceDir: string): string | undefined {
  try {
    const identityPath = path.join(workspaceDir, DEFAULT_IDENTITY_FILENAME);
    const content = fs.readFileSync(identityPath, "utf-8");
    const identity = parseIdentityMarkdown(content);
    return identity.name?.trim() || undefined;
  } catch {
    return undefined;
  }
}
