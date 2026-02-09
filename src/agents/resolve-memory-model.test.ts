/**
 * Unit Test: resolveMemoryModel
 *
 * Protocol: TEST-UNIT v1.0.0
 * SUT: resolveMemoryModel from resolve-memory-model.ts
 *
 * Purpose: Verify resolution of the "memory" model role from OpenClawConfig.
 */
import { describe, expect, it } from "vitest";
import { resolveMemoryModel } from "./resolve-memory-model.js";

describe("resolveMemoryModel", () => {
  it("returns parsed provider+model from modelRoles.memory", () => {
    const cfg = {
      agents: {
        defaults: {
          modelRoles: {
            primary: "google/gemini-3-pro-preview",
            memory: "google/gemini-2.0-flash",
          },
        },
      },
    };
    const result = resolveMemoryModel(cfg as any);
    expect(result).toEqual({
      provider: "google",
      model: "gemini-2.0-flash",
    });
  });

  it("returns undefined when config is undefined", () => {
    expect(resolveMemoryModel(undefined)).toBeUndefined();
  });

  it("returns undefined when modelRoles is missing", () => {
    const cfg = { agents: { defaults: {} } };
    expect(resolveMemoryModel(cfg as any)).toBeUndefined();
  });

  it("returns undefined when modelRoles is empty", () => {
    const cfg = { agents: { defaults: { modelRoles: {} } } };
    expect(resolveMemoryModel(cfg as any)).toBeUndefined();
  });

  it("returns undefined when 'memory' role is not set", () => {
    const cfg = {
      agents: {
        defaults: {
          modelRoles: {
            primary: "google/gemini-3-pro-preview",
            orchestrator: "ollama/llama3.1:8b",
          },
        },
      },
    };
    expect(resolveMemoryModel(cfg as any)).toBeUndefined();
  });

  it("parses cross-provider config (Gemini flagship + Haiku memory)", () => {
    const cfg = {
      agents: {
        defaults: {
          modelRoles: {
            primary: "google/gemini-3-pro-preview",
            memory: "anthropic/claude-3-haiku-20241022",
          },
        },
      },
    };
    const result = resolveMemoryModel(cfg as any);
    expect(result).toEqual({
      provider: "anthropic",
      model: "claude-3-haiku-20241022",
    });
  });

  it("handles model string without slash (model only, no provider)", () => {
    const cfg = {
      agents: {
        defaults: {
          modelRoles: { memory: "gemini-2.0-flash" },
        },
      },
    };
    const result = resolveMemoryModel(cfg as any);
    expect(result).toEqual({
      provider: "",
      model: "gemini-2.0-flash",
    });
  });
});
