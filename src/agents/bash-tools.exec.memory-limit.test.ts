import { describe, expect, it } from "vitest";
import { wrapWithMemoryLimit } from "./bash-tools.exec.js";

describe("wrapWithMemoryLimit", () => {
  it("returns command unchanged when limitMB is 0", () => {
    expect(wrapWithMemoryLimit("echo hello", 0)).toBe("echo hello");
  });

  it("returns command unchanged when limitMB is undefined", () => {
    expect(wrapWithMemoryLimit("echo hello", undefined)).toBe("echo hello");
  });

  it("returns command unchanged when limitMB is negative", () => {
    expect(wrapWithMemoryLimit("echo hello", -100)).toBe("echo hello");
  });

  it("wraps command with ulimit -v when limitMB is positive", () => {
    const result = wrapWithMemoryLimit("npm install", 8192);
    expect(result).toBe("ulimit -v 8388608 2>/dev/null; npm install");
  });

  it("converts MB to KB correctly (1 MB = 1024 KB)", () => {
    const result = wrapWithMemoryLimit("ls", 1);
    expect(result).toBe("ulimit -v 1024 2>/dev/null; ls");
  });

  it("handles large limits (32 GB)", () => {
    const result = wrapWithMemoryLimit("stress-test.sh", 32768);
    // 32768 MB * 1024 = 33554432 KB
    expect(result).toBe("ulimit -v 33554432 2>/dev/null; stress-test.sh");
  });

  it("preserves complex commands with pipes and redirects", () => {
    const cmd = "cat /dev/urandom | head -c 1G > /tmp/big.bin";
    const result = wrapWithMemoryLimit(cmd, 4096);
    expect(result).toBe(`ulimit -v 4194304 2>/dev/null; ${cmd}`);
  });

  it("preserves commands with quotes and special chars", () => {
    const cmd = `echo "hello world" && python3 -c 'print("test")'`;
    const result = wrapWithMemoryLimit(cmd, 2048);
    expect(result).toContain("ulimit -v 2097152");
    expect(result).toContain(cmd);
  });
});

describe("exec tool memory limit integration", () => {
  it("memoryLimitMB is in execSchema (parameter available to agents)", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ memoryLimitMB: 4096 });
    // The tool should be created without error and have the exec name
    expect(tool.name).toBe("exec");
    // The schema should include memoryLimitMB
    const schemaStr = JSON.stringify(tool.parameters);
    expect(schemaStr).toContain("memoryLimitMB");
  });
});
