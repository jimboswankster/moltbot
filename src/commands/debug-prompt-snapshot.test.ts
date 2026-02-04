/**
 * Prompt Snapshot command tests — no mocks. Uses isolated test home;
 * creates real workspace dir for success cases. Aligns with os/tests/README.md
 * (real tool, real output).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promptSnapshotCommand } from "./debug-prompt-snapshot.js";

describe("promptSnapshotCommand", () => {
  let runtime: {
    log: (msg: string) => void;
    error: (msg: string) => void;
    exit: (code: number) => void;
  };
  let logCalls: string[];
  let errorCalls: string[];
  let exitCode: number | null;

  beforeEach(() => {
    logCalls = [];
    errorCalls = [];
    exitCode = null;
    runtime = {
      log: (msg: string) => {
        logCalls.push(msg);
      },
      error: (msg: string) => {
        errorCalls.push(msg);
      },
      exit: (code: number) => {
        exitCode = code;
      },
    };
  });

  it("reports error and exits 1 when mode is query and message is missing", async () => {
    await promptSnapshotCommand(runtime as never, { mode: "query" });

    expect(errorCalls).toContain("When --mode is query, --message is required.");
    expect(exitCode).toBe(1);
  });

  it("reports error and exits 1 when mode is query and message is blank", async () => {
    await promptSnapshotCommand(runtime as never, { mode: "query", message: "   " });

    expect(errorCalls).toContain("When --mode is query, --message is required.");
    expect(exitCode).toBe(1);
  });

  describe("with real workspace (isolated test home)", () => {
    let workspaceDir: string;

    beforeEach(async () => {
      workspaceDir = path.join(os.homedir(), ".openclaw", "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
    });

    afterEach(async () => {
      const snapshotDir = path.join(workspaceDir, "os", "audits", "prompt-snapshots");
      try {
        const entries = await fs.readdir(snapshotDir);
        for (const name of entries) {
          await fs.unlink(path.join(snapshotDir, name)).catch(() => {});
        }
      } catch {
        // ignore
      }
    });

    it("logs success and does not exit when startup mode runs", async () => {
      await promptSnapshotCommand(runtime as never, { mode: "startup" });

      expect(exitCode).toBe(null);
      expect(errorCalls).toHaveLength(0);
      expect(logCalls.length).toBeGreaterThanOrEqual(3);
      expect(logCalls.some((m) => m.includes("Prompt snapshot written"))).toBe(true);
      expect(logCalls.some((m) => m.includes("Base:"))).toBe(true);
      expect(logCalls.some((m) => m.includes("Dir:"))).toBe(true);
    });

    it("logs success for query mode with message", async () => {
      await promptSnapshotCommand(runtime as never, {
        mode: "query",
        message: "What did we do last?",
      });

      expect(exitCode).toBe(null);
      expect(errorCalls).toHaveLength(0);
      expect(logCalls.some((m) => m.includes("Prompt snapshot written"))).toBe(true);
    });
  });
});
