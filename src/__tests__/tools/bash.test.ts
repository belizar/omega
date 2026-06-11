import { describe, it, expect, beforeEach } from "vitest";
import { BashTool } from "../../tools/bash.js";

describe("BashTool", () => {
  let bashTool: BashTool;

  beforeEach(() => {
    bashTool = new BashTool();
  });

  it("should execute simple commands", () => {
    const result = bashTool.execute({ command: "echo hello" });
    expect(result).toContain("hello");
  });

  it("should execute ls command", () => {
    const result = bashTool.execute({ command: "ls -la src" });
    expect(result).toBeTruthy();
  });

  it("should handle command errors gracefully", () => {
    const result = bashTool.execute({ command: "false" });
    expect(result).toBeTruthy(); // Returns error output
  });

  it("should block dangerous commands", () => {
    const result = bashTool.execute({ command: "rm -rf /" });
    expect(result).toContain("blocked");
  });

  it("should block fork bomb pattern", () => {
    const result = bashTool.execute({ command: ":() { :|:& };" });
    expect(result).toContain("blocked");
  });

  it("should validate command input", () => {
    const result = bashTool.execute({ command: "" });
    expect(result).toContain("Error");
  });

  it("should validate input type", () => {
    const result = bashTool.execute({ command: null } as any);
    expect(result).toContain("Error");
  });

  it("should allow safe commands", () => {
    const result = bashTool.execute({ command: "pwd" });
    expect(result).toBeTruthy();
    expect(result).not.toContain("blocked");
  });
});
