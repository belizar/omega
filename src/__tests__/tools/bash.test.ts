import { describe, it, expect, beforeEach } from "vitest";
import { BashTool } from "../../tools/bash.js";

describe("BashTool", () => {
  let bashTool: BashTool;

  beforeEach(() => {
    bashTool = new BashTool();
  });

  it("should execute simple commands", async () => {
    const result = await bashTool.execute({ command: "echo hello" });
    expect(result).toContain("hello");
  });

  it("should execute ls command", async () => {
    const result = await bashTool.execute({ command: "ls -la src" });
    expect(result).toBeTruthy();
  });

  it("should handle command errors gracefully", async () => {
    const result = await bashTool.execute({ command: "false" });
    expect(result).toBeTruthy(); // Returns error output
  });

  it("should block dangerous commands", async () => {
    const result = await bashTool.execute({ command: "rm -rf /" });
    expect(result).toContain("BLOQUEADO");
  });

  it("should block fork bomb pattern", async () => {
    const result = await bashTool.execute({ command: ":() { :|:& };" });
    expect(result).toContain("BLOQUEADO");
  });

  it("should validate command input", async () => {
    const result = await bashTool.execute({ command: "" });
    expect(result).toContain("Error");
  });

  it("should validate input type", async () => {
    const result = await bashTool.execute({ command: null } as any);
    expect(result).toContain("Error");
  });

  it("should allow safe commands", async () => {
    const result = await bashTool.execute({ command: "pwd" });
    expect(result).toBeTruthy();
    expect(result).not.toContain("BLOQUEADO");
  });
});
