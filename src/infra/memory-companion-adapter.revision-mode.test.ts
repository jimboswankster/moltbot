import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenClawSchema } from "../config/zod-schema.js";

const testState = vi.hoisted(() => ({
  factory: vi.fn(),
}));

vi.mock("jiti", () => ({
  createJiti: () => ({
    import: async () => ({ createMemoryCompanionAdapter: testState.factory }),
  }),
}));

import { loadMemoryCompanionAdapter } from "./memory-companion-adapter.js";

const adapter = {
  limitWithMemory: vi.fn(),
  onTurnComplete: vi.fn(),
  resolveModel: vi.fn(() => undefined),
};

describe("Memory Companion cold-store revision mode", () => {
  beforeEach(() => {
    testState.factory.mockReset();
    testState.factory.mockReturnValue(adapter);
  });

  it.each(["off", "observe", "active"] as const)(
    "accepts and forwards %s without activating it in the loader",
    async (coldStoreRevisionMode) => {
      const parsed = OpenClawSchema.parse({
        extensions: {
          memoryCompanion: {
            enabled: true,
            adapterPath: "/no-runtime-import-used-by-mocked-jiti.ts",
            coldStoreRevisionMode,
          },
        },
      });

      await loadMemoryCompanionAdapter(parsed);

      expect(testState.factory).toHaveBeenLastCalledWith(
        expect.objectContaining({
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
        },
      },
    });

    await loadMemoryCompanionAdapter(parsed);

    expect(testState.factory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        companionConfig: expect.objectContaining({ coldStoreRevisionMode: undefined }),
      }),
    );
  });

  it("rejects unknown revision modes", () => {
    const parsed = OpenClawSchema.safeParse({
      extensions: {
        memoryCompanion: {
          enabled: true,
          adapterPath: "/no-runtime-import-used-by-mocked-jiti.ts",
          coldStoreRevisionMode: "migrate-now",
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
