import { describe, expect, it } from "vitest";
import { parsePath } from "./config-cli.js";

describe("parsePath", () => {
  it("parses a flat dot path", () => {
    expect(parsePath("a.b.c")).toEqual(["a", "b", "c"]);
  });

  it("parses bracket-without-quotes (key containing slash)", () => {
    expect(parsePath("agents.defaults.models[local-dgx/gemma-4-26b-a4b-worker]")).toEqual([
      "agents",
      "defaults",
      "models",
      "local-dgx/gemma-4-26b-a4b-worker",
    ]);
  });

  it("strips surrounding double quotes inside brackets", () => {
    expect(parsePath('agents.defaults.models["local-dgx/foo"]')).toEqual([
      "agents",
      "defaults",
      "models",
      "local-dgx/foo",
    ]);
  });

  it("strips surrounding single quotes inside brackets", () => {
    expect(parsePath("agents.defaults.models['local-dgx/foo']")).toEqual([
      "agents",
      "defaults",
      "models",
      "local-dgx/foo",
    ]);
  });

  it("strips outermost matched quotes even when content has interior quote (consistent rule)", () => {
    expect(parsePath('foo["a"b"]')).toEqual(["foo", 'a"b']);
  });

  it("preserves quotes when only one side is quoted (no matched pair)", () => {
    expect(parsePath('foo["a]')).toEqual(["foo", '"a']);
  });

  it("treats array index segments", () => {
    expect(parsePath("a.b[2].c")).toEqual(["a", "b", "2", "c"]);
  });

  it("throws on empty bracket", () => {
    expect(() => parsePath("a[]")).toThrow(/empty/);
  });

  it("throws on bracket containing only quotes", () => {
    expect(() => parsePath('a[""]')).toThrow(/empty/);
  });

  it("throws on missing closing bracket", () => {
    expect(() => parsePath("a[b")).toThrow(/missing/);
  });

  it("supports escaped dots in segments", () => {
    expect(parsePath("a\\.b.c")).toEqual(["a.b", "c"]);
  });
});
