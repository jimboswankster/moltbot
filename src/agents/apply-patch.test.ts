import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
