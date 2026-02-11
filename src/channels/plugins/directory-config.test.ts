import { describe, expect, it, vi } from "vitest";
import {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./directory-config.js";

describe("directory (config-backed)", () => {
  it("lists Slack peers/groups from config", async () => {
    const cfg = {
      channels: {
        slack: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
          dm: { allowFrom: ["U123", "user:U999"] },
          dms: { U234: {} },
          channels: { C111: { users: ["U777"] } },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const peers = await listSlackDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(peers?.map((e) => e.id).toSorted()).toEqual([
      "user:u123",
      "user:u234",
      "user:u777",
      "user:u999",
    ]);

    const groups = await listSlackDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(groups?.map((e) => e.id)).toEqual(["channel:c111"]);
  });

  it("lists Discord peers/groups from config (numeric ids only)", async () => {
    const cfg = {
      channels: {
        discord: {
          token: "discord-test",
          dm: { allowFrom: ["<@111>", "nope"] },
          dms: { "222": {} },
          guilds: {
            "123": {
              users: ["<@12345>", "not-an-id"],
              channels: {
                "555": {},
                "channel:666": {},
                general: {},
              },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const peers = await listDiscordDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(peers?.map((e) => e.id).toSorted()).toEqual(["user:111", "user:12345", "user:222"]);

    const groups = await listDiscordDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(groups?.map((e) => e.id).toSorted()).toEqual(["channel:555", "channel:666"]);
  });

  it("lists Telegram peers/groups from config", async () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          allowFrom: ["123", "alice", "tg:@bob"],
          dms: { "456": {} },
          groups: { "-1001": {}, "*": {} },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const peers = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(peers?.map((e) => e.id).toSorted()).toEqual(["123", "456", "@alice", "@bob"]);

    const groups = await listTelegramDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(groups?.map((e) => e.id)).toEqual(["-1001"]);
  });

  // Contract: workspace identity (USER.md frontmatter) supplements the Telegram
  // directory nameMap. Config-level DM names take precedence over workspace names.
  // Source: src/channels/plugins/directory-config.ts — listTelegramDirectoryPeersFromConfig
  // Contract version: dynamic_identity_name_map plan (2026-02-11)

  it("supplements Telegram peers with workspace identity names", async () => {
    // Mock the workspace identity loader to provide a name for a peer
    const workspaceIdentity = await import("./workspace-identity.js");
    const spy = vi
      .spyOn(workspaceIdentity, "loadWorkspaceTelegramPeers")
      .mockReturnValue(new Map([["789", "WorkspaceUser"]]));

    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          allowFrom: ["789"],
          dms: {},
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const peers = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    // Observable: peer should exist with workspace identity name
    expect(peers.length).toBe(1);
    expect(peers[0].id).toBe("789");
    expect(peers[0].name).toBe("WorkspaceUser");

    spy.mockRestore();
  });

  it("config-level DM names take precedence over workspace identity names", async () => {
    const workspaceIdentity = await import("./workspace-identity.js");
    const spy = vi
      .spyOn(workspaceIdentity, "loadWorkspaceTelegramPeers")
      .mockReturnValue(new Map([["789", "WorkspaceName"]]));

    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          allowFrom: [],
          dms: { "789": { name: "ConfigName" } },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const peers = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    // Observable: config name wins over workspace name
    expect(peers.length).toBe(1);
    expect(peers[0].id).toBe("789");
    expect(peers[0].name).toBe("ConfigName");

    spy.mockRestore();
  });

  it("workspace identity name resolves via query", async () => {
    const workspaceIdentity = await import("./workspace-identity.js");
    const spy = vi
      .spyOn(workspaceIdentity, "loadWorkspaceTelegramPeers")
      .mockReturnValue(new Map([["555", "Alice"]]));

    const cfg = {
      channels: {
        telegram: {
          botToken: "telegram-test",
          allowFrom: ["555"],
          dms: {},
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const byName = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: "alice",
      limit: null,
    });
    expect(byName.length).toBe(1);
    expect(byName[0].name).toBe("Alice");

    const noMatch = await listTelegramDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: "bob",
      limit: null,
    });
    expect(noMatch.length).toBe(0);

    spy.mockRestore();
  });

  it("lists WhatsApp peers/groups from config", async () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+15550000000", "*", "123@g.us"],
          groups: { "999@g.us": { requireMention: true }, "*": {} },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    const peers = await listWhatsAppDirectoryPeersFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(peers?.map((e) => e.id)).toEqual(["+15550000000"]);

    const groups = await listWhatsAppDirectoryGroupsFromConfig({
      cfg,
      accountId: "default",
      query: null,
      limit: null,
    });
    expect(groups?.map((e) => e.id)).toEqual(["999@g.us"]);
  });
});
