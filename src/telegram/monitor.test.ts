import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { monitorTelegramProvider } from "./monitor.js";

type MockCtx = {
  message: {
    chat: { id: number; type: string; title?: string };
    text?: string;
    caption?: string;
  };
  me?: { username: string };
  getFile: () => Promise<unknown>;
};

// Fake bot to capture handler and API calls
const handlers: Record<string, (ctx: MockCtx) => Promise<void> | void> = {};
const api = {
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
  sendVideo: vi.fn(),
  sendAudio: vi.fn(),
  sendDocument: vi.fn(),
  setWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
};
const { initSpy, runSpy, loadConfig } = vi.hoisted(() => ({
  initSpy: vi.fn(async () => undefined),
  runSpy: vi.fn(() => ({
    task: () => Promise.resolve(),
    stop: vi.fn(),
  })),
  loadConfig: vi.fn(() => ({
    agents: { defaults: { maxConcurrent: 2 } },
    channels: { telegram: {} },
  })),
}));

const { computeBackoff, sleepWithAbort } = vi.hoisted(() => ({
  computeBackoff: vi.fn(() => 0),
  sleepWithAbort: vi.fn(async () => undefined),
}));
let latestCreateBotOpts: Record<string, unknown> | undefined;

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: (opts: Record<string, unknown>) => {
    latestCreateBotOpts = opts;
    handlers.message = async (ctx: MockCtx) => {
      const chatId = ctx.message.chat.id;
      const isGroup = ctx.message.chat.type !== "private";
      const text = ctx.message.text ?? ctx.message.caption ?? "";
      if (isGroup && !text.includes("@mybot")) {
        return;
      }
      if (!text.trim()) {
        return;
      }
      await api.sendMessage(chatId, `echo:${text}`, { parse_mode: "HTML" });
    };
    return {
      on: vi.fn(),
      api,
      me: { username: "mybot" },
      init: initSpy,
      stop: vi.fn(),
      start: vi.fn(),
    };
  },
  createTelegramWebhookCallback: vi.fn(),
}));

// Mock the grammyjs/runner to resolve immediately
vi.mock("@grammyjs/runner", () => ({
  run: runSpy,
}));

vi.mock("../infra/backoff.js", () => ({
  computeBackoff,
  sleepWithAbort,
}));

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: async (ctx: { Body?: string }) => ({
    text: `echo:${ctx.Body}`,
  }),
}));

describe("monitorTelegramProvider (grammY)", () => {
  const originalTelemetryFile = process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE;
  const originalLegacyMirror = process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY;

  beforeEach(() => {
    latestCreateBotOpts = undefined;
    loadConfig.mockReturnValue({
      agents: { defaults: { maxConcurrent: 2 } },
      channels: { telegram: {} },
    });
    initSpy.mockClear();
    runSpy.mockReset();
    runSpy.mockImplementation(() => ({
      task: () => Promise.resolve(),
      stop: vi.fn(),
    }));
    computeBackoff.mockReset();
    computeBackoff.mockImplementation(() => 0);
    sleepWithAbort.mockReset();
    sleepWithAbort.mockImplementation(async () => undefined);
    if (originalTelemetryFile === undefined) delete process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE;
    else process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = originalTelemetryFile;
    if (originalLegacyMirror === undefined)
      delete process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY;
    else process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = originalLegacyMirror;
  });

  it("processes a DM and sends reply", async () => {
    Object.values(api).forEach((fn) => {
      fn?.mockReset?.();
    });
    await monitorTelegramProvider({ token: "tok" });
    expect(handlers.message).toBeDefined();
    await handlers.message?.({
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        text: "hi",
      },
      me: { username: "mybot" },
      getFile: vi.fn(async () => ({})),
    });
    expect(api.sendMessage).toHaveBeenCalledWith(123, "echo:hi", {
      parse_mode: "HTML",
    });
  });

  it("uses agent maxConcurrent for runner concurrency", async () => {
    runSpy.mockClear();
    loadConfig.mockReturnValue({
      agents: { defaults: { maxConcurrent: 3 } },
      channels: { telegram: {} },
    });

    await monitorTelegramProvider({ token: "tok" });

    expect(runSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sink: { concurrency: 3 },
        runner: expect.objectContaining({
          silent: true,
          maxRetryTime: 5 * 60 * 1000,
          retryInterval: "exponential",
        }),
      }),
    );
  });

  it("requires mention in groups by default", async () => {
    Object.values(api).forEach((fn) => {
      fn?.mockReset?.();
    });
    await monitorTelegramProvider({ token: "tok" });
    await handlers.message?.({
      message: {
        message_id: 2,
        chat: { id: -99, type: "supergroup", title: "G" },
        text: "hello all",
      },
      me: { username: "mybot" },
      getFile: vi.fn(async () => ({})),
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("retries on recoverable network errors", async () => {
    const networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    runSpy
      .mockImplementationOnce(() => ({
        task: () => Promise.reject(networkError),
        stop: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        task: () => Promise.resolve(),
        stop: vi.fn(),
      }));

    await monitorTelegramProvider({ token: "tok" });

    expect(computeBackoff).toHaveBeenCalled();
    expect(sleepWithAbort).toHaveBeenCalled();
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("logs offset diagnostics on recoverable restart", async () => {
    const networkError = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    const runtime = { log: vi.fn(), error: vi.fn() };
    runSpy
      .mockImplementationOnce(() => ({
        task: () => {
          const onUpdateObserved = latestCreateBotOpts?.diagnostics as
            | {
                onUpdateObserved?: (details: {
                  updateId: number;
                  skipped: boolean;
                  reason?: "stale_offset" | "dedupe";
                }) => void;
              }
            | undefined;
          onUpdateObserved?.onUpdateObserved?.({ updateId: 42, skipped: false });
          onUpdateObserved?.onUpdateObserved?.({
            updateId: 41,
            skipped: true,
            reason: "stale_offset",
          });
          return Promise.reject(networkError);
        },
        stop: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        task: () => Promise.resolve(),
        stop: vi.fn(),
      }));

    await monitorTelegramProvider({ token: "tok", runtime });

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("acceptedOffset=42"));
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("lastSkipped=41"));
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("polling start account=default"),
    );
  });

  it("surfaces non-recoverable errors", async () => {
    runSpy.mockImplementationOnce(() => ({
      task: () => Promise.reject(new Error("bad token")),
      stop: vi.fn(),
    }));

    await expect(monitorTelegramProvider({ token: "tok" })).rejects.toThrow("bad token");
  });

  it("rejects a second poller start for the same account while active", async () => {
    let releaseFirst: (() => void) | null = null;
    runSpy
      .mockImplementationOnce(() => ({
        task: () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
        stop: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        task: () => Promise.resolve(),
        stop: vi.fn(),
      }));

    const first = monitorTelegramProvider({ token: "tok", accountId: "default" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(monitorTelegramProvider({ token: "tok", accountId: "default" })).rejects.toThrow(
      "telegram poller already running for account=default",
    );

    releaseFirst?.();
    await first;
  });

  it("emits runtime telemetry for singleton poller conflicts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-singleton-"));
    const telemetryPath = path.join(root, "runtime-telemetry.jsonl");
    process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = telemetryPath;
    process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "0";

    let releaseFirst: (() => void) | null = null;
    runSpy
      .mockImplementationOnce(() => ({
        task: () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
        stop: vi.fn(),
      }))
      .mockImplementationOnce(() => ({
        task: () => Promise.resolve(),
        stop: vi.fn(),
      }));

    const first = monitorTelegramProvider({ token: "tok", accountId: "default" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(monitorTelegramProvider({ token: "tok", accountId: "default" })).rejects.toThrow(
      "telegram poller already running for account=default",
    );

    releaseFirst?.();
    await first;

    const rows = fs
      .readFileSync(telemetryPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event?: string; details?: Record<string, unknown> });
    const conflictEvent = rows.find((row) => row.event === "telegram.poller_singleton_conflict");
    expect(conflictEvent).toBeDefined();
    expect(conflictEvent?.details?.accountId).toBe("default");
  });

  it("rejects startup when a cross-process poller lock already exists for the account", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-cross-process-"));
    const stateDir = path.join(root, "state");
    const lockDir = path.join(stateDir, "telegram");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "poller-default.lock"),
      JSON.stringify({
        pid: process.pid,
        accountId: "default",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    await expect(
      monitorTelegramProvider({ token: "tok", accountId: "default", env }),
    ).rejects.toThrow("telegram poller lock already held for account=default");
  });

  it("emits telemetry when cross-process poller lock is already held", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-cross-telemetry-"));
    const stateDir = path.join(root, "state");
    const lockDir = path.join(stateDir, "telegram");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "poller-default.lock"),
      JSON.stringify({
        pid: process.pid,
        accountId: "default",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const telemetryPath = path.join(root, "runtime-telemetry.jsonl");
    process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = telemetryPath;
    process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "0";

    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await expect(
      monitorTelegramProvider({ token: "tok", accountId: "default", env }),
    ).rejects.toThrow("telegram poller lock already held for account=default");

    const rows = fs
      .readFileSync(telemetryPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event?: string; details?: Record<string, unknown> });
    const conflictEvent = rows.find((row) => row.event === "telegram.poller_lock_conflict");
    expect(conflictEvent).toBeDefined();
    expect(conflictEvent?.details?.accountId).toBe("default");
    const preflightEvent = rows.find(
      (row) => row.event === "telegram.poller_lock_preflight_checked",
    );
    expect(preflightEvent).toBeDefined();
    expect(preflightEvent?.details?.accountId).toBe("default");
    expect(preflightEvent?.details?.result).toBe("conflict");
  });

  it("reclaims stale cross-process poller lock and starts successfully", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-stale-lock-"));
    const stateDir = path.join(root, "state");
    const lockDir = path.join(stateDir, "telegram");
    fs.mkdirSync(lockDir, { recursive: true });
    const lockPath = path.join(lockDir, "poller-default.lock");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, accountId: "default", createdAt: "2000-01-01T00:00:00.000Z" }),
      "utf8",
    );
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(lockPath, staleAt, staleAt);

    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TELEGRAM_POLLER_LOCK_STALE_MS: "1000",
    };
    const telemetryPath = path.join(root, "runtime-telemetry.jsonl");
    process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = telemetryPath;
    process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "0";
    await expect(
      monitorTelegramProvider({ token: "tok", accountId: "default", env }),
    ).resolves.toBe(undefined);

    const rows = fs
      .readFileSync(telemetryPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event?: string; details?: Record<string, unknown> });
    const reclaimedEvent = rows.find((row) => row.event === "telegram.poller_lock_reclaimed");
    expect(reclaimedEvent).toBeDefined();
    expect(reclaimedEvent?.details?.accountId).toBe("default");
    expect(reclaimedEvent?.details?.reason).toBe("dead_pid");
  });

  it("reclaims fresh lock when owner pid is not alive", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-dead-pid-lock-"));
    const stateDir = path.join(root, "state");
    const lockDir = path.join(stateDir, "telegram");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "poller-default.lock"),
      JSON.stringify({
        pid: 999999,
        accountId: "default",
        createdAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TELEGRAM_POLLER_LOCK_STALE_MS: String(60 * 60 * 1000),
    };

    await expect(
      monitorTelegramProvider({ token: "tok", accountId: "default", env }),
    ).resolves.toBe(undefined);
  });

  it("reports lock owner metadata in conflict error for operator diagnostics", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-lock-owner-meta-"));
    const stateDir = path.join(root, "state");
    const lockDir = path.join(stateDir, "telegram");
    fs.mkdirSync(lockDir, { recursive: true });
    const createdAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(lockDir, "poller-default.lock"),
      JSON.stringify({ pid: process.pid, accountId: "default", createdAt }),
      "utf8",
    );
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    await expect(
      monitorTelegramProvider({ token: "tok", accountId: "default", env }),
    ).rejects.toThrow(
      `telegram poller lock already held for account=default (ownerPid=${process.pid}`,
    );
  });

  it("logs preflight lock-owner diagnostics before throwing on lock conflict", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-lock-preflight-log-"));
    const stateDir = path.join(root, "state");
    const lockDir = path.join(stateDir, "telegram");
    fs.mkdirSync(lockDir, { recursive: true });
    const createdAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(lockDir, "poller-default.lock"),
      JSON.stringify({ pid: process.pid, accountId: "default", createdAt }),
      "utf8",
    );
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const runtime = { log: vi.fn(), error: vi.fn() };

    await expect(
      monitorTelegramProvider({ token: "tok", accountId: "default", env, runtime }),
    ).rejects.toThrow("telegram poller lock already held for account=default");

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("telegram poller preflight conflict account=default"),
    );
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(`ownerPid=${process.pid}`));
  });

  it("emits preflight-checked telemetry on successful poller lock acquisition", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-preflight-checked-"));
    const stateDir = path.join(root, "state");
    const telemetryPath = path.join(root, "runtime-telemetry.jsonl");
    process.env.OPENCLAW_RUNTIME_TELEMETRY_FILE = telemetryPath;
    process.env.OPENCLAW_RUNTIME_TELEMETRY_WRITE_LEGACY = "0";
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    await expect(
      monitorTelegramProvider({ token: "tok", accountId: "default", env }),
    ).resolves.toBe(undefined);

    const rows = fs
      .readFileSync(telemetryPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { event?: string; details?: Record<string, unknown> });
    const preflightEvent = rows.find(
      (row) => row.event === "telegram.poller_lock_preflight_checked",
    );
    expect(preflightEvent).toBeDefined();
    expect(preflightEvent?.details?.accountId).toBe("default");
    expect(preflightEvent?.details?.mode).toBe("polling");
    expect(preflightEvent?.details?.result).toBe("acquired");
  });

  it("fails fast with diagnostics when permission preflight cannot create telegram state dir", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    const mkdirSpy = vi.spyOn(fsPromises, "mkdir").mockImplementation(async (...args) => {
      const target = String(args[0] ?? "");
      if (target.includes("/telegram")) {
        const err = new Error("permission denied") as Error & { code?: string };
        err.code = "EACCES";
        throw err;
      }
      return undefined as never;
    });
    try {
      await expect(monitorTelegramProvider({ token: "tok", runtime })).rejects.toThrow(
        "telegram monitor permission preflight failed",
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("telegram monitor permission preflight failed"),
      );
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it("fails fast when permission preflight cannot create telemetry directory", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };
    const mkdirSpy = vi.spyOn(fsPromises, "mkdir").mockImplementation(async (...args) => {
      const target = String(args[0] ?? "");
      if (target.includes("telemetry-denied")) {
        const err = new Error("permission denied") as Error & { code?: string };
        err.code = "EACCES";
        throw err;
      }
      return undefined as never;
    });
    const env = {
      ...process.env,
      OPENCLAW_RUNTIME_TELEMETRY_FILE: "/tmp/telemetry-denied/runtime-telemetry.jsonl",
    };
    try {
      await expect(monitorTelegramProvider({ token: "tok", runtime, env })).rejects.toThrow(
        "telegram monitor permission preflight failed",
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("telegram monitor permission preflight failed"),
      );
    } finally {
      mkdirSpy.mockRestore();
    }
  });
});
