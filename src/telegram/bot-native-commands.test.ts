import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

const { listSkillCommandsForAgents } = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
}));

vi.mock("../auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents,
}));

describe("registerTelegramNativeCommands", () => {
  beforeEach(() => {
    listSkillCommandsForAgents.mockReset();
  });

  const buildParams = (cfg: OpenClawConfig, accountId = "default") => ({
    bot: {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      command: vi.fn(),
    } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    cfg,
    runtime: {} as RuntimeEnv,
    accountId,
    telegramCfg: {} as TelegramAccountConfig,
    allowFrom: [],
    groupAllowFrom: [],
    replyToMode: "off" as const,
    textLimit: 4096,
    useAccessGroups: false,
    nativeEnabled: true,
    nativeSkillsEnabled: true,
    nativeDisabledExplicit: false,
    resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    resolveTelegramGroupConfig: () => ({
      groupConfig: undefined,
      topicConfig: undefined,
    }),
    shouldSkipUpdate: () => false,
    opts: { token: "token" },
  });

  it("scopes skill commands when account binding exists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
      bindings: [
        {
          agentId: "butler",
          match: { channel: "telegram", accountId: "bot-a" },
        },
      ],
    };

    registerTelegramNativeCommands(buildParams(cfg, "bot-a"));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["butler"],
    });
  });

  it("keeps skill commands unscoped without a matching binding", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
    };

    registerTelegramNativeCommands(buildParams(cfg, "bot-a"));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({ cfg });
  });

  it("caps the registered menu while retaining explicit commands and all handlers", () => {
    listSkillCommandsForAgents.mockReturnValue(
      Array.from({ length: 120 }, (_, index) => ({
        name: `skill_${index}`,
        skillName: `skill-${index}`,
        description: `Skill ${index}`,
      })),
    );
    const runtimeLog = vi.fn();
    const params = buildParams({});
    params.telegramCfg = {
      customCommands: [{ command: "priority_custom", description: "Priority custom" }],
    } as TelegramAccountConfig;
    params.runtime = { log: runtimeLog } as RuntimeEnv;
    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    params.bot.api.setMyCommands = setMyCommands;

    registerTelegramNativeCommands(params);

    expect(setMyCommands).toHaveBeenCalledTimes(1);
    const menuCommands = setMyCommands.mock.calls[0]?.[0];
    expect(menuCommands).toHaveLength(100);
    expect(menuCommands).toContainEqual({
      command: "priority_custom",
      description: "Priority custom",
    });
    expect(menuCommands).not.toContainEqual(expect.objectContaining({ command: "skill_119" }));
    const handlerRegistrations = (params.bot.command as ReturnType<typeof vi.fn>).mock.calls;
    expect(handlerRegistrations).toContainEqual(["skill_119", expect.any(Function)]);
    expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("at most 100 commands"));
  });
});
