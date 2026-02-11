import { describe, expect, it } from "vitest";
import { parseIdentityMarkdown } from "./identity-file.js";

describe("parseIdentityMarkdown", () => {
  it("ignores identity template placeholders", () => {
    const content = `
# IDENTITY.md - Who Am I?

- **Name:** *(pick something you like)*
- **Creature:** *(AI? robot? familiar? ghost in the machine? something weirder?)*
- **Vibe:** *(how do you come across? sharp? warm? chaotic? calm?)*
- **Emoji:** *(your signature - pick one that feels right)*
- **Avatar:** *(workspace-relative path, http(s) URL, or data URI)*
`;
    const parsed = parseIdentityMarkdown(content);
    expect(parsed).toEqual({});
  });

  it("parses explicit identity values", () => {
    const content = `
- **Name:** Samantha
- **Creature:** Robot
- **Vibe:** Warm
- **Emoji:** :robot:
- **Avatar:** avatars/openclaw.png
`;
    const parsed = parseIdentityMarkdown(content);
    expect(parsed).toEqual({
      name: "Samantha",
      creature: "Robot",
      vibe: "Warm",
      emoji: ":robot:",
      avatar: "avatars/openclaw.png",
    });
  });

  it("prefers YAML frontmatter name over body-parsed name", () => {
    const content = `---
name: FrontmatterName
---

# IDENTITY.md - Who Am I?

## **NAME:** BodyName
`;
    const parsed = parseIdentityMarkdown(content);
    expect(parsed.name).toBe("FrontmatterName");
  });

  it("uses body-parsed name when frontmatter has no name", () => {
    const content = `---
creature: AI helper
---

# IDENTITY.md - Who Am I?

- **Name:** BodyName
- **Vibe:** Be direct, warm, and operational.
`;
    const parsed = parseIdentityMarkdown(content);
    expect(parsed.name).toBe("BodyName");
    expect(parsed.creature).toBe("AI helper");
  });

  it("frontmatter overrides all identity fields", () => {
    const content = `---
name: FmName
emoji: 🤖
creature: protocol droid
vibe: sharp
theme: dark
avatar: fm-avatar.png
---

- **Name:** BodyName
- **Emoji:** 🦊
- **Creature:** Robot
- **Vibe:** Warm
- **Theme:** light
- **Avatar:** body-avatar.png
`;
    const parsed = parseIdentityMarkdown(content);
    expect(parsed).toEqual({
      name: "FmName",
      emoji: "🤖",
      creature: "protocol droid",
      vibe: "sharp",
      theme: "dark",
      avatar: "fm-avatar.png",
    });
  });

  it("parses real IDENTITY.md with frontmatter + body", () => {
    const content = `---
# These fields are programmatically consumed by gateway systems
# (agent identity, Telegram directory, reply prefixes).
# Changes here propagate automatically on next agent boot.
name: Simon
creature: AI assistant
---

# IDENTITY.md - Who Am I?

- **Name:** OldSimon
- **Creature:** Old creature
- **Vibe:** Be direct, warm, and operational.
- **Emoji:** *(your signature — pick one that feels right)*
`;
    const parsed = parseIdentityMarkdown(content);
    // Frontmatter takes precedence
    expect(parsed.name).toBe("Simon");
    expect(parsed.creature).toBe("AI assistant");
    // Body-parsed values used when frontmatter doesn't have them
    expect(parsed.vibe).toBe("Be direct, warm, and operational.");
    // Emoji is a placeholder — should be excluded
    expect(parsed.emoji).toBeUndefined();
  });

  it("handles content with no frontmatter (backward compat)", () => {
    const content = `
# IDENTITY.md - Who Am I?

- **Name:** Legacy
- **Creature:** Old bot
`;
    const parsed = parseIdentityMarkdown(content);
    expect(parsed.name).toBe("Legacy");
    expect(parsed.creature).toBe("Old bot");
  });
});
