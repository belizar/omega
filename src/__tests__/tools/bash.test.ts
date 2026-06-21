import { describe, it, expect, beforeEach } from "vitest";
import { BashTool } from "../../tools/bash.js";

describe("BashTool", () => {
  let bashTool: BashTool;

  beforeEach(() => {
    bashTool = new BashTool();
  });

  it("should execute simple commands", async () => {
    const { output } = await bashTool.execute({ command: "echo hello" });
    expect(output).toContain("hello");
  });

  it("should execute ls command", async () => {
    const { output } = await bashTool.execute({ command: "ls -la src" });
    expect(output).toBeTruthy();
  });

  it("should handle command errors gracefully", async () => {
    const { output } = await bashTool.execute({ command: "false" });
    expect(output).toBeTruthy();
  });
  it("should validate command input", async () => {
    const { output } = await bashTool.execute({ command: "" });
    expect(output).toContain("Error");
  });

  it("should validate input type", async () => {
    const { output } = await bashTool.execute({ command: null } as any);
    expect(output).toContain("Error");
  });

  it("should allow safe commands", async () => {
    const { output } = await bashTool.execute({ command: "pwd" });
    expect(output).toBeTruthy();
    expect(output).not.toContain("BLOQUEADO");
  });

  it("should hardblock rm -rf even without classifier", async () => {
    const { output } = await bashTool.execute({ command: "rm -rf /" });
    expect(output).toContain("BLOQUEADO POR GUARDARRAÍL DETERMINISTA");
    expect(output).toContain("rm -rf");
  });

  it("should hardblock fork bomb pattern", async () => {
    const { output } = await bashTool.execute({ command: ":() { :|:& };" });
    expect(output).toContain("BLOQUEADO POR GUARDARRAÍL DETERMINISTA");
  });

  it("should allow hardblocked command with force: true", async () => {
    const { output } = await bashTool.execute({ command: "rm -rf /tmp/nonexistent", force: true });
    expect(output).not.toContain("BLOQUEADO");
  });

  it("should hardblock dd to device", async () => {
    const { output } = await bashTool.execute({ command: "dd if=/dev/zero of=/dev/sda" });
    expect(output).toContain("BLOQUEADO POR GUARDARRAÍL DETERMINISTA");
  });

  it("should hardblock mkfs", async () => {
    const { output } = await bashTool.execute({ command: "mkfs.ext4 /dev/sda1" });
    expect(output).toContain("BLOQUEADO POR GUARDARRAÍL DETERMINISTA");
  });

  it("should hardblock shutdown", async () => {
    const { output } = await bashTool.execute({ command: "shutdown -h now" });
    expect(output).toContain("BLOQUEADO POR GUARDARRAÍL DETERMINISTA");
  });
});