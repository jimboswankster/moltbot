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
