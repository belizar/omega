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

  it("should hardblock rm -rf even without classifier", async () => {
    const result = await bashTool.execute({ command: "rm -rf /" });
    expect(result).toContain("BLOQUEADO POR GUARDARRAÍL DETERMINISTA");
    expect(result).toContain("rm -rf");
  });

  it("should hardblock fork bomb pattern", async () => {
    const result = await bashTool.execute({ command: ":() { :|:& };" });
    expect(result).toContain("BLOQUEADO POR GUARDARRAÍL DETERMINISTA");
  });

  it("should allow hardblocked command with force: true", async () => {
    const result = await bashTool.execute({ command: "rm -rf /tmp/nonexistent", force: true });
    expect(result).not.toContain("BLOQUEADO");
  });

  it("should hardblock dd to device", async () => {
    const result = await bashTool.execute({ command: "dd if=/dev/zero of=/dev/sda" });
    expect(result).toContain("BLOQUEADO POR GUARDARRAÍL DETERMINISTA");
  });

  it("should hardblock mkfs", async () => {
    const result = await bashTool.execute({ command: "mkfs.ext4 /dev/sda1" });
    expect(result).toContain("BLOQUEADO POR GUARDARRAÍL DETERMINISTA");
  });

  it("should hardblock shutdown", async () => {
    const result = await bashTool.execute({ command: "shutdown -h now" });
    expect(result).toContain("BLOQUEADO POR GUARDARRAÍL DETERMINISTA");
  });

  // ── Timeout por llamada ──────────────────────────────────────────────
  it("should time out a slow command when a short per-call timeout is given", async () => {
    // sleep 3 con timeout: 1 → debe matarse al segundo.
    const result = await bashTool.execute({ command: "sleep 3", timeout: 1 });
    expect(result).toContain("timeout de 1s");
  });

  it("should respect a generous per-call timeout for a quick command", async () => {
    const result = await bashTool.execute({ command: "echo ok", timeout: 600 });
    expect(result).toContain("ok");
    expect(result).not.toContain("timeout");
  });

  // ── Interrumpibilidad (Ctrl+C mata el proceso) ───────────────────────
  it("should kill the child process when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    // Abortamos a los 100ms un sleep de 10s.
    setTimeout(() => controller.abort(), 100);
    const result = await bashTool.execute(
      { command: "sleep 10" },
      controller.signal,
    );
    expect(result).toContain("interrumpido por el usuario");
    // Retornó mucho antes de los 10s → el proceso se mató de verdad.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("should not run a command whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await bashTool.execute(
      { command: "echo deberia-no-correr" },
      controller.signal,
    );
    expect(result).toContain("cancelado antes de ejecutar");
    expect(result).not.toContain("deberia-no-correr");
  });
});
