/**
 * Integration test: Dynamic Identity Name Resolution
 *
 * Exercises the full pipeline with real files on disk:
 *   USER.md (YAML frontmatter) → loadWorkspaceTelegramPeers() → directory nameMap → query resolution
 *   IDENTITY.md (YAML frontmatter) → loadWorkspaceAgentName() → parsed name
 *
 * No mocks. Real fs, real YAML parsing, real directory resolution.
 *
 * Interface: file system → frontmatter parser → workspace identity loader → directory config
 * Observable: directory entries with names, agent name string
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTelegramDirectoryPeersFromConfig } from "./directory-config.js";
import { loadWorkspaceAgentName, loadWorkspaceTelegramPeers } from "./workspace-identity.js";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-identity-integration-"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeUserMd(content: string) {
  await fs.writeFile(path.join(tmpDir, "USER.md"), content, "utf-8");
}

async function writeIdentityMd(content: string) {
  await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), content, "utf-8");
}

function buildTelegramCfg(overrides: Record<string, unknown> = {}) {
  return {
    agents: {
      defaults: { workspace: tmpDir },
    },
    channels: {
      telegram: {
        botToken: "integration-test-token",
        allowFrom: ["8538705539"],
        dms: {},
        ...overrides,
      },
    },
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// loadWorkspaceTelegramPeers — real files
// ---------------------------------------------------------------------------

describe("loadWorkspaceTelegramPeers (real files)", () => {
  it("reads USER.md from disk and extracts name + chat_id", async () => {
    // Observable: Map returned from real file read + frontmatter parse
    await writeUserMd(`---
# These fields are programmatically consumed by gateway systems
# (Telegram DM directory, identity resolution, channel routing).
# Changes here propagate automatically on next agent boot.
name: James
call_me: James
timezone: America/New_York
telegram_chat_id: "8538705539"
---

# USER.md - About Your Human

- **Name:** James
- **Timezone:** America/New_York
`);

    const peers = loadWorkspaceTelegramPeers(tmpDir);

    // Observable: return value from real file → parse → Map
    expect(peers.size).toBe(1);
    expect(peers.get("8538705539")).toBe("James");
  });

  it("uses call_me when name is absent in real file", async () => {
    await writeUserMd(`---
call_me: Jay
telegram_chat_id: "12345"
---
`);

    const peers = loadWorkspaceTelegramPeers(tmpDir);
    // Observable: call_me fallback from real file
    expect(peers.size).toBe(1);
    expect(peers.get("12345")).toBe("Jay");
  });

  it("returns empty map from real file with no frontmatter", async () => {
    await writeUserMd(`# USER.md - About Your Human

- **Name:** James
- **Timezone:** America/New_York
`);

    const peers = loadWorkspaceTelegramPeers(tmpDir);
    // Observable: no frontmatter → no telegram peers
    expect(peers.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// loadWorkspaceAgentName — real files
// ---------------------------------------------------------------------------

describe("loadWorkspaceAgentName (real files)", () => {
  it("extracts agent name from IDENTITY.md frontmatter on disk", async () => {
    // Observable: string returned from real file read + parseIdentityMarkdown
    await writeIdentityMd(`---
# These fields are programmatically consumed by gateway systems
# (agent identity, Telegram directory, reply prefixes).
# Changes here propagate automatically on next agent boot.
name: Simon
---

# IDENTITY.md - Who Am I?

- **Name:** OldSimon
- **Creature:** A helpful AI Assistant
`);

    const name = loadWorkspaceAgentName(tmpDir);
    // Observable: frontmatter "Simon" overrides body "OldSimon"
    expect(name).toBe("Simon");
  });

  it("falls back to body-parsed name from real file without frontmatter", async () => {
    await writeIdentityMd(`# IDENTITY.md - Who Am I?

- **Name:** BodyOnlyBot
- **Creature:** A helpful AI Assistant
`);

    const name = loadWorkspaceAgentName(tmpDir);
    // Observable: body-parsed name when no frontmatter present
    expect(name).toBe("BodyOnlyBot");
  });

  it("returns undefined from real empty file", async () => {
    await writeIdentityMd("");

    const name = loadWorkspaceAgentName(tmpDir);
    // Observable: empty file produces no name
    expect(name).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: file on disk → directory peer with name → query resolution
// ---------------------------------------------------------------------------

describe("end-to-end: USER.md → Telegram directory → query", () => {
  it("resolves user name from real USER.md through full directory pipeline", async () => {
    // Interface: file system → frontmatter → workspace identity → directory config
    // Observable: ChannelDirectoryEntry[] with .name from real file
    await writeUserMd(`---
name: James
telegram_chat_id: "8538705539"
---

# USER.md
`);

    const cfg = buildTelegramCfg();
    const peers = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });

    // Observable: peer exists with name from USER.md frontmatter
    const james = peers.find((e) => e.id === "8538705539");
    expect(james).toBeDefined();
    expect(james!.name).toBe("James");
  });

  it("resolves user by name query through full pipeline", async () => {
    await writeUserMd(`---
name: James
telegram_chat_id: "8538705539"
---
`);

    const cfg = buildTelegramCfg();

    // Observable: query "james" matches the workspace-sourced name
    const byName = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: "james",
      limit: null,
    });
    expect(byName.length).toBe(1);
    expect(byName[0].id).toBe("8538705539");
    expect(byName[0].name).toBe("James");

    // Observable: query "bob" returns no matches
    const noMatch = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: "bob",
      limit: null,
    });
    expect(noMatch.length).toBe(0);
  });

  it("config DM name overrides workspace name in full pipeline", async () => {
    await writeUserMd(`---
name: WorkspaceJames
telegram_chat_id: "8538705539"
---
`);

    // Config-level name takes precedence over workspace USER.md
    const cfg = buildTelegramCfg({
      dms: { "8538705539": { name: "ConfigJames" } },
    });

    const peers = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });

    // Observable: config name wins
    const james = peers.find((e) => e.id === "8538705539");
    expect(james).toBeDefined();
    expect(james!.name).toBe("ConfigJames");
  });

  it("directory works with no USER.md file present", async () => {
    // Remove USER.md to test graceful degradation in full pipeline
    try {
      await fs.unlink(path.join(tmpDir, "USER.md"));
    } catch {
      // File might not exist; that's fine
    }

    const cfg = buildTelegramCfg();

    const peers = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });

    // Observable: peer still in directory (from allowFrom) but without a name
    const peer = peers.find((e) => e.id === "8538705539");
    expect(peer).toBeDefined();
    expect(peer!.name).toBeUndefined();
  });
});
