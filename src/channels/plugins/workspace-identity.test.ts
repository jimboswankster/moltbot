import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWorkspaceAgentName, loadWorkspaceTelegramPeers } from "./workspace-identity.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadWorkspaceTelegramPeers", () => {
  it("extracts name + telegram_chat_id from USER.md frontmatter", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`---
name: James
call_me: James
timezone: America/New_York
telegram_chat_id: "8538705539"
---

# USER.md
`);
    const peers = loadWorkspaceTelegramPeers("/fake/workspace");
    expect(peers.size).toBe(1);
    expect(peers.get("8538705539")).toBe("James");
    expect(fs.readFileSync).toHaveBeenCalledWith(path.join("/fake/workspace", "USER.md"), "utf-8");
  });

  it("falls back to call_me when name is absent", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`---
call_me: Jay
telegram_chat_id: "12345"
---
`);
    const peers = loadWorkspaceTelegramPeers("/fake/workspace");
    expect(peers.get("12345")).toBe("Jay");
  });

  it("returns empty map and warns when USER.md has name but no telegram_chat_id", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`---
name: James
---
`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const peers = loadWorkspaceTelegramPeers("/fake/workspace");
    // Observable: SUT returns empty map
    expect(peers.size).toBe(0);
    // Observable: SUT emits a warning about missing chat_id
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no telegram_chat_id"));
  });

  it("returns empty map when USER.md has no frontmatter", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`# USER.md

- **Name:** James
`);
    const peers = loadWorkspaceTelegramPeers("/fake/workspace");
    expect(peers.size).toBe(0);
  });

  it("returns empty map when USER.md is missing", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const peers = loadWorkspaceTelegramPeers("/fake/workspace");
    expect(peers.size).toBe(0);
  });

  it("returns empty map when frontmatter has neither name nor call_me", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`---
timezone: America/New_York
telegram_chat_id: "8538705539"
---
`);
    const peers = loadWorkspaceTelegramPeers("/fake/workspace");
    expect(peers.size).toBe(0);
  });
});

describe("loadWorkspaceAgentName", () => {
  it("extracts name from IDENTITY.md frontmatter (canonical)", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`---
name: Simon
---

# IDENTITY.md - Who Am I?

- **Name:** Simon
`);
    const name = loadWorkspaceAgentName("/fake/workspace");
    expect(name).toBe("Simon");
    expect(fs.readFileSync).toHaveBeenCalledWith(
      path.join("/fake/workspace", "IDENTITY.md"),
      "utf-8",
    );
  });

  it("frontmatter name takes precedence over body name", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`---
name: FrontmatterBot
---

- **Name:** BodyBot
`);
    const name = loadWorkspaceAgentName("/fake/workspace");
    expect(name).toBe("FrontmatterBot");
  });

  it("falls back to body-parsed name when no frontmatter", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`# IDENTITY.md - Who Am I?

- **Name:** BodyOnly
`);
    const name = loadWorkspaceAgentName("/fake/workspace");
    expect(name).toBe("BodyOnly");
  });

  it("returns undefined when IDENTITY.md is missing", () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const name = loadWorkspaceAgentName("/fake/workspace");
    expect(name).toBeUndefined();
  });

  it("returns undefined when IDENTITY.md has no name at all", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(`# IDENTITY.md - Who Am I?

- **Creature:** Robot
`);
    const name = loadWorkspaceAgentName("/fake/workspace");
    expect(name).toBeUndefined();
  });

  it("returns undefined when IDENTITY.md is empty", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("");
    const name = loadWorkspaceAgentName("/fake/workspace");
    // Observable: empty content produces no name
    expect(name).toBeUndefined();
  });
});
