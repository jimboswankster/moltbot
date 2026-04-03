import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: vi.fn(),
  readQwenCliCredentialsCached: vi.fn(),
  readMiniMaxCliCredentialsCached: vi.fn(),
}));

describe("syncExternalCliCredentials", () => {
  it("syncs openai-codex default profile from local Codex auth when stale", async () => {
    vi.resetModules();
    const { readCodexCliCredentialsCached } = await import("../cli-credentials.js");
    const now = Date.now();
    vi.mocked(readCodexCliCredentialsCached).mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: now + 60 * 60 * 1000,
      accountId: "acct_123",
    });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "expired-access",
          refresh: "expired-refresh",
          expires: now - 60 * 1000,
          accountId: "acct_123",
        },
      },
    };

    const { syncExternalCliCredentials } = await import("./external-cli-sync.js");
    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles["openai-codex:default"]).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-access",
      refresh: "fresh-refresh",
      accountId: "acct_123",
    });
  });

  it("removes deprecated codex-cli profile when syncing canonical openai-codex default", async () => {
    vi.resetModules();
    const { readCodexCliCredentialsCached } = await import("../cli-credentials.js");
    const now = Date.now();
    vi.mocked(readCodexCliCredentialsCached).mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: "fresh-access",
      refresh: "fresh-refresh",
      expires: now + 60 * 60 * 1000,
      accountId: "acct_123",
    });

    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:codex-cli": {
          type: "oauth",
          provider: "openai-codex",
          access: "old-access",
          refresh: "old-refresh",
          expires: now - 1000,
        },
      },
    };

    const { syncExternalCliCredentials } = await import("./external-cli-sync.js");
    const mutated = syncExternalCliCredentials(store);

    expect(mutated).toBe(true);
    expect(store.profiles["openai-codex:default"]).toBeDefined();
    expect(store.profiles["openai-codex:codex-cli"]).toBeUndefined();
  });
});
