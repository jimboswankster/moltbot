import { afterEach, expect, test } from "vitest";
import { sleep } from "../utils.js";
import { getSession, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool, resetExecRetryBrakeForTests } from "./bash-tools.exec.js";
import { killProcessTree } from "./shell-utils.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetExecRetryBrakeForTests();
});

test("retry brake enforce blocks repeated timeout command fingerprints", async () => {
  const tool = createExecTool({ retryBrakeMode: "enforce" });
  const command = 'node -e "setTimeout(() => {}, 250)"';

  await expect(tool.execute("call-1", { command, timeout: 0.05 })).rejects.toThrow("timed out");
  await expect(tool.execute("call-2", { command, timeout: 0.05 })).rejects.toThrow("timed out");
  await expect(tool.execute("call-3", { command, timeout: 1 })).rejects.toThrow(
    "blocked: exec retry brake active",
  );
});

test("retry brake shadow preserves execution while surfacing would-block diagnostics", async () => {
  const enforceTool = createExecTool({ retryBrakeMode: "enforce" });
  const shadowTool = createExecTool({ retryBrakeMode: "shadow" });
  const command = 'node -e "setTimeout(() => {}, 200)"';

  await expect(enforceTool.execute("call-1", { command, timeout: 0.05 })).rejects.toThrow(
    "timed out",
  );
  await expect(enforceTool.execute("call-2", { command, timeout: 0.05 })).rejects.toThrow(
    "timed out",
  );

  const result = await shadowTool.execute("call-3", { command, timeout: 1 });
  expect(result.details.status).toBe("completed");
  expect(result.details.policy?.retryBrake.mode).toBe("shadow");
  expect(result.details.policy?.retryBrake.blocked).toBe(true);
  expect(result.details.policy?.retryBrake.enforced).toBe(false);
  expect(result.content.find((item) => item.type === "text")?.text ?? "").toContain(
    "Shadow retry-brake",
  );
});

test("auto-background policy exposes enforce vs shadow decisions", async () => {
  if (process.platform === "win32") {
    return;
  }
  const command = `sh -lc "sleep 0.2; echo build done"`;

  const enforceTool = createExecTool({
    allowBackground: true,
    backgroundMs: 10_000,
    autoBackgroundMode: "enforce",
  });
  const enforce = await enforceTool.execute("call-enforce", { command });
  expect(enforce.details.status).toBe("running");
  expect(enforce.details.policy?.autoBackground.mode).toBe("enforce");
  expect(enforce.details.policy?.autoBackground.wouldBackground).toBe(true);
  expect(enforce.details.policy?.autoBackground.applied).toBe(true);

  const sessionId = (enforce.details as { sessionId?: string }).sessionId;
  const running = sessionId ? getSession(sessionId) : undefined;
  if (running?.pid) {
    killProcessTree(running.pid);
  }

  await sleep(40);

  const shadowTool = createExecTool({
    allowBackground: true,
    backgroundMs: 10_000,
    autoBackgroundMode: "shadow",
  });
  const shadow = await shadowTool.execute("call-shadow", { command });
  expect(shadow.details.status).toBe("completed");
  expect(shadow.details.policy?.autoBackground.mode).toBe("shadow");
  expect(shadow.details.policy?.autoBackground.wouldBackground).toBe(true);
  expect(shadow.details.policy?.autoBackground.applied).toBe(false);
  expect(shadow.content.find((item) => item.type === "text")?.text ?? "").toContain(
    "Shadow auto-background",
  );
});
