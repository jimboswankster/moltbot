import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveCronStore } from "./store.js";

describe("cron store symlink-aware writes", () => {
  it("writes through symlink target without replacing the symlink", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-store-link-"));
    const workspaceDir = path.join(dir, "workspace", "os", "cron");
    const liveDir = path.join(dir, "cron");
    const canonicalPath = path.join(workspaceDir, "jobs.json");
    const livePath = path.join(liveDir, "jobs.json");

    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(liveDir, { recursive: true });
    await fs.writeFile(canonicalPath, JSON.stringify({ version: 1, jobs: [] }, null, 2), "utf-8");
    await fs.symlink(canonicalPath, livePath);

    await saveCronStore(livePath, {
      version: 1,
      jobs: [{ id: "job-1", name: "job-1" }] as never,
    });

    const liveStat = await fs.lstat(livePath);
    expect(liveStat.isSymbolicLink()).toBe(true);

    const canonicalRaw = await fs.readFile(canonicalPath, "utf-8");
    const parsed = JSON.parse(canonicalRaw) as { jobs: Array<{ id: string }> };
    expect(parsed.jobs[0]?.id).toBe("job-1");

    const bakRaw = await fs.readFile(`${canonicalPath}.bak`, "utf-8");
    const bakParsed = JSON.parse(bakRaw) as { jobs: Array<{ id: string }> };
    expect(bakParsed.jobs[0]?.id).toBe("job-1");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
