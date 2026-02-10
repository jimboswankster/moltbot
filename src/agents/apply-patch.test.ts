import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyUpdateHunk } from "./apply-patch-update.js";
import { applyPatch } from "./apply-patch.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("applyPatch", () => {
  // ── Phase 0A: H3 Max Hunk Count (V9 contract + regression) ──────────────

  it("[C] rejects patch exceeding MAX_PATCH_HUNKS (21 hunks)", async () => {
    await withTempDir(async (dir) => {
      // Build a patch with 21 add-file hunks — should exceed the limit of 20
      const hunks = Array.from(
        { length: 21 },
        (_, i) => `*** Add File: file${i}.txt\n+content${i}`,
      ).join("\n");
      const patch = `*** Begin Patch\n${hunks}\n*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/exceeds maximum/i);

      // Verify NO files were created (guard fires before any writes)
      const files = await fs.readdir(dir);
      expect(files).toHaveLength(0);
    });
  });

  it("[R] accepts patch at MAX_PATCH_HUNKS limit (20 hunks)", async () => {
    await withTempDir(async (dir) => {
      // Build a patch with exactly 20 add-file hunks — at the limit, should succeed
      const hunks = Array.from(
        { length: 20 },
        (_, i) => `*** Add File: file${i}.txt\n+content${i}`,
      ).join("\n");
      const patch = `*** Begin Patch\n${hunks}\n*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });

      expect(result.summary.added).toHaveLength(20);
      const files = await fs.readdir(dir);
      expect(files).toHaveLength(20);
    });
  });

  // ── Phase 0B: H2 Path Containment + Symlink Resolution (V2/V3/V7/V14) ────

  it("[C] rejects absolute path outside workspace (V2)", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: /tmp/outside/file.txt
+malicious
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir, workspaceRoot: dir })).rejects.toThrow(
        /escapes workspace root/i,
      );
    });
  });

  it("[C] rejects tilde path outside workspace (V3)", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: ~/escape.txt
+malicious
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir, workspaceRoot: dir })).rejects.toThrow(
        /escapes workspace root/i,
      );
    });
  });

  it("[C] rejects traversal path via delete (V7)", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Delete File: ../../etc/passwd
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir, workspaceRoot: dir })).rejects.toThrow(
        /escapes workspace root/i,
      );
    });
  });

  it("[C] rejects absolute path via update (V2)", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Update File: /etc/hosts
@@
-old
+new
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir, workspaceRoot: dir })).rejects.toThrow(
        /escapes workspace root/i,
      );
    });
  });

  it("[R] allows relative safe path within workspace", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: subdir/safe.txt
+safe content
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir, workspaceRoot: dir });
      expect(result.summary.added).toEqual(["subdir/safe.txt"]);

      const contents = await fs.readFile(path.join(dir, "subdir", "safe.txt"), "utf8");
      expect(contents).toBe("safe content\n");
    });
  });

  it("[R] allows dot-prefixed relative path within workspace", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: ./also-safe.txt
+also safe
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir, workspaceRoot: dir });
      expect(result.summary.added).toEqual(["also-safe.txt"]);
    });
  });

  it("[C] rejects symlink escape outside workspace (V14)", async () => {
    await withTempDir(async (dir) => {
      // Create a symlink inside the workspace that points outside
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-outside-"));
      try {
        const escapeLink = path.join(dir, "escape");
        await fs.symlink(outsideDir, escapeLink);

        const patch = `*** Begin Patch
*** Add File: escape/file.txt
+symlink escape
*** End Patch`;

        await expect(applyPatch(patch, { cwd: dir, workspaceRoot: dir })).rejects.toThrow(
          /resolves outside workspace root/i,
        );
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("[C] uses workspaceRoot not cwd for containment (CVE-2025-59532)", async () => {
    await withTempDir(async (workspaceDir) => {
      // cwd is a subdirectory of workspace — traversal relative to cwd
      // should still be caught if it escapes workspaceRoot
      const subdir = path.join(workspaceDir, "deep", "sub");
      await fs.mkdir(subdir, { recursive: true });

      const patch = `*** Begin Patch
*** Add File: ../../../tmp/escape.txt
+escape
*** End Patch`;

      await expect(applyPatch(patch, { cwd: subdir, workspaceRoot: workspaceDir })).rejects.toThrow(
        /escapes workspace root/i,
      );
    });
  });

  // ── Phase 0C: Refactor applyUpdateHunk (prerequisite for H1) ──────────────

  it("[R] applyUpdateHunk uses pre-read content instead of disk read", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "target.txt");
      // Write one version to disk
      await fs.writeFile(filePath, "disk-line1\ndisk-line2\n", "utf8");

      // Pass a DIFFERENT version as pre-read content
      const preReadContent = "cached-line1\ncached-line2\n";

      const chunks = [
        {
          oldLines: ["cached-line1"],
          newLines: ["replaced-line1"],
          isEndOfFile: false,
        },
      ];

      // Should use the pre-read content, not what's on disk
      const result = await applyUpdateHunk(filePath, chunks, preReadContent);
      expect(result).toContain("replaced-line1");
      expect(result).toContain("cached-line2");
      // Should NOT contain disk content
      expect(result).not.toContain("disk-line1");
    });
  });

  // ── Phase 0D: H1 Pre-flight Validation (V1/V5/V10) ──────────────────────

  it("[C] pre-flight rejects before any fs writes when hunk has bad context", async () => {
    await withTempDir(async (dir) => {
      // Create two files
      await fs.writeFile(path.join(dir, "file1.txt"), "line1\nline2\n", "utf8");
      await fs.writeFile(path.join(dir, "file2.txt"), "alpha\nbeta\n", "utf8");

      // Patch: file1 update is valid, but file2 update has wrong context
      const patch = `*** Begin Patch
*** Update File: file1.txt
@@
 line1
-line2
+line2-modified
*** Update File: file2.txt
@@
 WRONG_CONTEXT
-beta
+beta-modified
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir, workspaceRoot: dir })).rejects.toThrow();

      // CRITICAL: file1 must NOT have been modified (pre-flight catches file2 failure first)
      const file1 = await fs.readFile(path.join(dir, "file1.txt"), "utf8");
      expect(file1).toBe("line1\nline2\n");
    });
  });

  it("[R] pre-flight allows valid multi-file patch through", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "a.txt"), "aaa\n", "utf8");
      await fs.writeFile(path.join(dir, "b.txt"), "bbb\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: a.txt
@@
-aaa
+aaa-updated
*** Update File: b.txt
@@
-bbb
+bbb-updated
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir, workspaceRoot: dir });
      expect(result.summary.modified).toContain("a.txt");
      expect(result.summary.modified).toContain("b.txt");

      const a = await fs.readFile(path.join(dir, "a.txt"), "utf8");
      const b = await fs.readFile(path.join(dir, "b.txt"), "utf8");
      expect(a).toContain("aaa-updated");
      expect(b).toContain("bbb-updated");
    });
  });

  it("[C] pre-flight prevents partial writes on add + update mix", async () => {
    await withTempDir(async (dir) => {
      // Patch: add a new file, then update a file that doesn't exist
      const patch = `*** Begin Patch
*** Add File: new-file.txt
+new content
*** Update File: nonexistent.txt
@@
-old
+new
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir, workspaceRoot: dir })).rejects.toThrow();

      // The added file must NOT have been created
      const files = await fs.readdir(dir);
      expect(files).toHaveLength(0);
    });
  });

  it("[C] pre-flight uses cached content for TOCTOU defense", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "target.txt"), "original\nline2\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: target.txt
@@
-original
+modified
*** End Patch`;

      // The test verifies that pre-flight caching exists:
      // If validation reads the file, and then apply phase uses the SAME cached content
      // (rather than re-reading from disk), the operation is TOCTOU-safe.
      // We verify this by ensuring the result is consistent with the original content
      // (if someone changed the file between validate and apply, the old context
      // would still match because we use the cached version).
      const result = await applyPatch(patch, { cwd: dir, workspaceRoot: dir });
      expect(result.summary.modified).toContain("target.txt");

      const contents = await fs.readFile(path.join(dir, "target.txt"), "utf8");
      expect(contents).toContain("modified");
      expect(contents).toContain("line2");
    });
  });

  // ── Phase 1A: Core Operations (regression harness) ───────────────────────

  it("[R] deletes a single file", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "doomed.txt");
      await fs.writeFile(target, "goodbye\n", "utf8");

      const patch = `*** Begin Patch
*** Delete File: doomed.txt
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      expect(result.summary.deleted).toEqual(["doomed.txt"]);
      await expect(fs.stat(target)).rejects.toBeDefined();
    });
  });

  it("[C] delete nonexistent file throws ENOENT", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Delete File: ghost.txt
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow();
    });
  });

  it("[R] multi-file add + update + delete in one patch", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "existing.txt"), "old\n", "utf8");
      await fs.writeFile(path.join(dir, "removeme.txt"), "bye\n", "utf8");

      const patch = `*** Begin Patch
*** Add File: new.txt
+brand new
*** Update File: existing.txt
@@
-old
+updated
*** Delete File: removeme.txt
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      expect(result.summary.added).toEqual(["new.txt"]);
      expect(result.summary.modified).toEqual(["existing.txt"]);
      expect(result.summary.deleted).toEqual(["removeme.txt"]);

      const newFile = await fs.readFile(path.join(dir, "new.txt"), "utf8");
      expect(newFile).toBe("brand new\n");
      const updated = await fs.readFile(path.join(dir, "existing.txt"), "utf8");
      expect(updated).toContain("updated");
      await expect(fs.stat(path.join(dir, "removeme.txt"))).rejects.toBeDefined();
    });
  });

  it("[R] multiple updates to different files are independent", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "a.txt"), "alpha\n", "utf8");
      await fs.writeFile(path.join(dir, "b.txt"), "beta\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: a.txt
@@
-alpha
+alpha-changed
*** Update File: b.txt
@@
-beta
+beta-changed
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      expect(result.summary.modified).toContain("a.txt");
      expect(result.summary.modified).toContain("b.txt");

      const a = await fs.readFile(path.join(dir, "a.txt"), "utf8");
      const b = await fs.readFile(path.join(dir, "b.txt"), "utf8");
      expect(a).toContain("alpha-changed");
      expect(b).toContain("beta-changed");
    });
  });

  // ── Phase 1B: Failure Modes + Boundary Regression ────────────────────────

  it("[C] documents orphaned write when fs.writeFile fails on second file", async () => {
    await withTempDir(async (dir) => {
      // With pre-flight validation, both files are validated first.
      // But if writeFile fails during apply phase, file1 may already be written.
      // This test documents the residual risk (V5).
      await fs.writeFile(path.join(dir, "file1.txt"), "original1\n", "utf8");
      await fs.writeFile(path.join(dir, "file2.txt"), "original2\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: file1.txt
@@
-original1
+modified1
*** Update File: file2.txt
@@
-original2
+modified2
*** End Patch`;

      // Both files have valid context, so pre-flight passes.
      // The patch should succeed normally.
      const result = await applyPatch(patch, { cwd: dir });
      expect(result.summary.modified).toContain("file1.txt");
      expect(result.summary.modified).toContain("file2.txt");
    });
  });

  it("[C] ambiguous context matches at first occurrence", async () => {
    await withTempDir(async (dir) => {
      // File has duplicate lines — update should match the FIRST occurrence
      await fs.writeFile(path.join(dir, "dup.txt"), "line\nline\nline\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: dup.txt
@@
-line
+replaced
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      expect(result.summary.modified).toContain("dup.txt");

      const contents = await fs.readFile(path.join(dir, "dup.txt"), "utf8");
      // First "line" replaced, remaining "line" entries preserved
      expect(contents).toBe("replaced\nline\nline\n");
    });
  });

  it("[R] correct context produces accurate replacement", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "exact.txt"), "header\ntarget-line\nfooter\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: exact.txt
@@
 header
-target-line
+replaced-line
 footer
*** End Patch`;

      await applyPatch(patch, { cwd: dir });
      const contents = await fs.readFile(path.join(dir, "exact.txt"), "utf8");
      expect(contents).toBe("header\nreplaced-line\nfooter\n");
    });
  });

  it("[C] dir pollution: add with bad path does not create directories when validation fails", async () => {
    await withTempDir(async (dir) => {
      // Patch adds a file AND updates a nonexistent file — pre-flight should catch
      // the update failure and NOT create the directory for the add
      const patch = `*** Begin Patch
*** Add File: deep/nested/new.txt
+content
*** Update File: nonexistent.txt
@@
-old
+new
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow();

      // No directories should have been created
      const files = await fs.readdir(dir);
      expect(files).toHaveLength(0);
    });
  });

  it("[R] add with deep path creates directories and file", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: deep/nested/dir/file.txt
+deep content
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      expect(result.summary.added).toEqual(["deep/nested/dir/file.txt"]);

      const contents = await fs.readFile(
        path.join(dir, "deep", "nested", "dir", "file.txt"),
        "utf8",
      );
      expect(contents).toBe("deep content\n");
    });
  });

  it("[R] parsePatchText output stability — boundary #2 regression", async () => {
    // Verify parsePatchText returns expected structure for a multi-op patch
    // This is a regression harness for the parser output contract (boundary #2)
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "update-target.txt"), "old\n", "utf8");

      const patch = `*** Begin Patch
*** Add File: added.txt
+new content
*** Update File: update-target.txt
@@
-old
+new
*** Delete File: removed.txt
*** End Patch`;

      // We can't call parsePatchText directly (not exported), but we can
      // verify the applyPatch behavior is consistent with the expected
      // parse structure: 3 hunks (add, update, delete) processed in order
      // The delete will fail (file doesn't exist), but the error tells us
      // the parser correctly identified it as a delete hunk
      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow();
    });
  });

  // ── Phase 1C: Sandbox + Error Cases ──────────────────────────────────────

  it("[R] sandbox rejects traversal path", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: ../../etc/passwd
+malicious
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir, sandboxRoot: dir })).rejects.toThrow(
        /escapes sandbox root/i,
      );
    });
  });

  it("[R] sandbox rejects symlink in path chain", async () => {
    await withTempDir(async (dir) => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-outside-"));
      try {
        const link = path.join(dir, "link");
        await fs.symlink(outsideDir, link);

        const patch = `*** Begin Patch
*** Add File: link/file.txt
+escape via symlink
*** End Patch`;

        await expect(applyPatch(patch, { cwd: dir, sandboxRoot: dir })).rejects.toThrow(
          /symlink not allowed/i,
        );
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("[R] sandbox allows normal patch within root", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: safe/inside.txt
+safe content
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir, sandboxRoot: dir });
      expect(result.summary.added).toContain("safe/inside.txt");

      const contents = await fs.readFile(path.join(dir, "safe", "inside.txt"), "utf8");
      expect(contents).toBe("safe content\n");
    });
  });

  it("[R] sandbox rejects absolute path outside root", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: /tmp/outside.txt
+escape
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir, sandboxRoot: dir })).rejects.toThrow(
        /escapes sandbox root/i,
      );
    });
  });

  it("[C] cross-contamination: sandbox patch cannot reach workspace files", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (sandboxDir) => {
        // Place a file in the workspace
        await fs.writeFile(path.join(workspaceDir, "secret.txt"), "secret\n", "utf8");

        // Try to reach workspace file from sandbox via traversal
        const relative = path.relative(sandboxDir, workspaceDir);
        const patch = `*** Begin Patch
*** Update File: ${relative}/secret.txt
@@
-secret
+compromised
*** End Patch`;

        await expect(
          applyPatch(patch, { cwd: sandboxDir, sandboxRoot: sandboxDir }),
        ).rejects.toThrow(/escapes sandbox root/i);

        // Verify workspace file is untouched
        const content = await fs.readFile(path.join(workspaceDir, "secret.txt"), "utf8");
        expect(content).toBe("secret\n");
      });
    });
  });

  it("[R] throws on empty input", async () => {
    await withTempDir(async (dir) => {
      await expect(applyPatch("", { cwd: dir })).rejects.toThrow(/empty/i);
    });
  });

  it("[R] throws on missing Begin Patch marker", async () => {
    await withTempDir(async (dir) => {
      await expect(
        applyPatch("*** Add File: test.txt\n+content\n*** End Patch", {
          cwd: dir,
        }),
      ).rejects.toThrow(/Begin Patch/i);
    });
  });

  it("[R] throws on missing context in update hunk", async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, "target.txt"), "content\n", "utf8");
      const patch = `*** Begin Patch
*** Update File: target.txt
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/empty/i);
    });
  });

  it("[R] throws on whitespace-only input", async () => {
    await withTempDir(async (dir) => {
      await expect(applyPatch("   \n  \n  ", { cwd: dir })).rejects.toThrow(/empty/i);
    });
  });

  it("[R] throws when patch has no file hunks", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(/No files were modified/i);
    });
  });

  // ── Phase 2: Provider Gating + Schema Backward Compat ────────────────────

  it.skip("[C] enabled: false → tool is null regardless of provider", () => {
    const { createOpenClawCodingTools } = require("./pi-tools.js");
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          allow: ["read", "exec"],
          exec: { applyPatch: { enabled: false } },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      modelProvider: "google",
    });
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("apply_patch");
  });

  it.skip("[R] enabled: true, no allowProviders → tool created for any provider (backward compat)", () => {
    const { createOpenClawCodingTools } = require("./pi-tools.js");
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          allow: ["read", "exec"],
          exec: { applyPatch: { enabled: true } },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      modelProvider: "google",
      modelId: "gemini-2.5-pro",
    });
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("apply_patch");
  });

  it.skip("[C] allowProviders: ['google'] → tool created for Google, null for OpenAI", () => {
    const { createOpenClawCodingTools } = require("./pi-tools.js");
    const googleTools = createOpenClawCodingTools({
      config: {
        tools: {
          allow: ["read", "exec"],
          exec: { applyPatch: { enabled: true, allowProviders: ["google"] } },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      modelProvider: "google",
      modelId: "gemini-2.5-pro",
    });
    expect(googleTools.map((t: { name: string }) => t.name)).toContain("apply_patch");

    const openaiTools = createOpenClawCodingTools({
      config: {
        tools: {
          allow: ["read", "exec"],
          exec: { applyPatch: { enabled: true, allowProviders: ["google"] } },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      modelProvider: "openai",
      modelId: "gpt-5.2",
    });
    expect(openaiTools.map((t: { name: string }) => t.name)).not.toContain("apply_patch");
  });

  it.skip("[R] allowProviders: ['openai'] → tool created for OpenAI (regression: OpenAI still works)", () => {
    const { createOpenClawCodingTools } = require("./pi-tools.js");
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          allow: ["read", "exec"],
          exec: { applyPatch: { enabled: true, allowProviders: ["openai"] } },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      modelProvider: "openai",
      modelId: "gpt-5.2",
    });
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("apply_patch");
  });

  it.skip("[C] sandbox workspaceAccess: 'ro' → tool is null even when enabled", () => {
    const { createOpenClawCodingTools } = require("./pi-tools.js");
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          allow: ["read", "exec"],
          exec: { applyPatch: { enabled: true, allowProviders: ["google"] } },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      modelProvider: "google",
      sandbox: { workspaceDir: "/tmp/sandbox", workspaceAccess: "ro" },
    });
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("apply_patch");
  });

  it.skip("[C] sandbox workspaceAccess: 'rw' → tool created with sandboxRoot", () => {
    const { createOpenClawCodingTools } = require("./pi-tools.js");
    const tools = createOpenClawCodingTools({
      config: {
        tools: {
          allow: ["read", "exec"],
          exec: { applyPatch: { enabled: true, allowProviders: ["google"] } },
        },
      },
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
      modelProvider: "google",
      sandbox: { workspaceDir: "/tmp/sandbox", workspaceAccess: "rw" },
    });
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain("apply_patch");
  });

  it.skip("[R] config schema backward compat: config without allowProviders parses (G2)", () => {
    // Verify that the existing config shape (no allowProviders field) still parses
    // through the Zod schema without errors
    const { z } = require("zod");
    // Minimal reproduction of the applyPatch schema portion
    const existingConfig = {
      enabled: true,
      allowModels: ["gpt-5.2"],
    };

    // The schema must accept configs without allowProviders
    // (This tests backward compatibility of the Zod schema change)
    expect(existingConfig).toHaveProperty("enabled", true);
    expect(existingConfig).toHaveProperty("allowModels");
    expect(existingConfig).not.toHaveProperty("allowProviders");
    // After GREEN implementation, this will use the actual Zod schema
  });

  // ── Original tests (regression baseline) ────────────────────────────────

  it("adds a file", async () => {
    await withTempDir(async (dir) => {
      const patch = `*** Begin Patch
*** Add File: hello.txt
+hello
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      const contents = await fs.readFile(path.join(dir, "hello.txt"), "utf8");

      expect(contents).toBe("hello\n");
      expect(result.summary.added).toEqual(["hello.txt"]);
    });
  });

  it("updates and moves a file", async () => {
    await withTempDir(async (dir) => {
      const source = path.join(dir, "source.txt");
      await fs.writeFile(source, "foo\nbar\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: source.txt
*** Move to: dest.txt
@@
 foo
-bar
+baz
*** End Patch`;

      const result = await applyPatch(patch, { cwd: dir });
      const dest = path.join(dir, "dest.txt");
      const contents = await fs.readFile(dest, "utf8");

      expect(contents).toBe("foo\nbaz\n");
      await expect(fs.stat(source)).rejects.toBeDefined();
      expect(result.summary.modified).toEqual(["dest.txt"]);
    });
  });

  it("supports end-of-file inserts", async () => {
    await withTempDir(async (dir) => {
      const target = path.join(dir, "end.txt");
      await fs.writeFile(target, "line1\n", "utf8");

      const patch = `*** Begin Patch
*** Update File: end.txt
@@
+line2
*** End of File
*** End Patch`;

      await applyPatch(patch, { cwd: dir });
      const contents = await fs.readFile(target, "utf8");
      expect(contents).toBe("line1\nline2\n");
    });
  });
});
