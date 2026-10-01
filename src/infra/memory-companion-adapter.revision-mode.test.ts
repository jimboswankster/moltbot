import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";

const testState = vi.hoisted(() => ({
  factory: vi.fn(),
  identityFactory: vi.fn(),
}));

vi.mock("jiti", () => ({
  createJiti: () => ({
    import: async () => ({
      createMemoryCompanionAdapter: testState.factory,
      createOpenClawSessionIdentityAdapter: testState.identityFactory,
    }),
  }),
}));

import { loadMemoryCompanionAdapter } from "./memory-companion-adapter.js";

const adapter = {
  limitWithMemory: vi.fn(),
  onTurnComplete: vi.fn(),
  resolveModel: vi.fn(() => undefined),
};

const sessionIdentity = {
  target: "openclaw" as const,
  resolve: vi.fn(),
};

const sessionIdentityScope = {
  runtimeProfileId: "synthetic-openclaw-profile",
  tenantId: "synthetic-tenant",
  brandId: "synthetic-brand",
  workspaceId: "synthetic-workspace",
};

describe("Memory Companion cold-store revision mode", () => {
  beforeEach(() => {
    testState.factory.mockReset();
    testState.factory.mockReturnValue(adapter);
    testState.identityFactory.mockReset();
    testState.identityFactory.mockReturnValue(sessionIdentity);
  });

  it.each(["off", "observe", "active"] as const)(
    "accepts and forwards %s without activating it in the loader",
    async (coldStoreRevisionMode) => {
      const parsed = OpenClawSchema.parse({
        extensions: {
          memoryCompanion: {
            enabled: true,
            adapterPath: "/no-runtime-import-used-by-mocked-jiti.ts",
            sessionIdentityScope,
            coldStoreRevisionMode,
          },
        },
      });

      await loadMemoryCompanionAdapter(parsed, undefined, undefined, "synthetic-agent");

      expect(testState.factory).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sessionIdentity,
          companionConfig: expect.objectContaining({ coldStoreRevisionMode }),
        }),
      );
    },
  );

  it("preserves the adapter's off-by-default behavior when the setting is omitted", async () => {
    const parsed = OpenClawSchema.parse({
      extensions: {
        memoryCompanion: {
          enabled: true,
          adapterPath: "/no-runtime-import-used-by-mocked-jiti.ts",
          sessionIdentityScope,
        },
      },
    });

    await loadMemoryCompanionAdapter(parsed, undefined, undefined, "synthetic-agent");

    const deps = testState.factory.mock.calls.at(-1)?.[0];
    expect(deps?.sessionIdentity).toBe(sessionIdentity);
    expect(Object.hasOwn(deps?.companionConfig ?? {}, "coldStoreRevisionMode")).toBe(false);
    expect(testState.identityFactory).toHaveBeenCalledWith({
      ...sessionIdentityScope,
      agentId: "synthetic-agent",
    });
  });

  it("fails closed before constructing the adapter when canonical identity scope is absent", async () => {
    const parsed = OpenClawSchema.parse({
      extensions: {
        memoryCompanion: {
          enabled: true,
          adapterPath: "/no-runtime-import-used-by-mocked-jiti.ts",
        },
      },
    });

    await expect(
      loadMemoryCompanionAdapter(parsed, undefined, undefined, "synthetic-agent"),
    ).resolves.toBeNull();
    expect(testState.identityFactory).not.toHaveBeenCalled();
    expect(testState.factory).not.toHaveBeenCalled();
  });

  it("fails closed before importing identity when the actual agent id is absent", async () => {
    const parsed = OpenClawSchema.parse({
      extensions: {
        memoryCompanion: {
          enabled: true,
          adapterPath: "/no-runtime-import-used-by-mocked-jiti.ts",
          sessionIdentityScope,
        },
      },
    });

    await expect(loadMemoryCompanionAdapter(parsed)).resolves.toBeNull();
    expect(testState.identityFactory).not.toHaveBeenCalled();
    expect(testState.factory).not.toHaveBeenCalled();
  });

  it("rejects unknown revision modes", () => {
    const parsed = OpenClawSchema.safeParse({
      extensions: {
        memoryCompanion: {
          enabled: true,
          adapterPath: "/no-runtime-import-used-by-mocked-jiti.ts",
          sessionIdentityScope,
          coldStoreRevisionMode: "migrate-now",
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
