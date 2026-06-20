import { describe, it, expect, beforeEach, vi } from "vitest";
import { BashTool } from "../../tools/bash.js";
import { CommandClassifier } from "../../classifier/classifier.js";
import { OverrideManager } from "../../classifier/overrides.js";

describe("BashTool with classifier", () => {
  let overrides: OverrideManager;

  beforeEach(async () => {
    overrides = await OverrideManager.load(
      `.omega/test-bash-classifier-${process.pid}-${Date.now()}.json`,
    );
  });

  it("should execute command directly when classifier returns safe", async () => {
    const mockClassify = vi.fn().mockResolvedValue({
      verdict: "safe" as const,
      reason: "Comando inofensivo",
      source: "classifier" as const,
    });

    const classifier = new CommandClassifier(overrides, "test-key");
    vi.spyOn(classifier, "classify").mockImplementation(mockClassify);

    const tool = new BashTool({ classifier });

    const result = await tool.execute({ command: "echo hello" });

    expect(result).toContain("hello");
    expect(mockClassify).toHaveBeenCalledWith("echo hello");
  });

  it("should return BLOQUEADO message when classifier returns dangerous", async () => {
    const mockClassify = vi.fn().mockResolvedValue({
      verdict: "dangerous" as const,
      reason: "Modifica el filesystem",
      source: "classifier" as const,
    });

    const classifier = new CommandClassifier(overrides, "test-key");
    vi.spyOn(classifier, "classify").mockImplementation(mockClassify);

    const tool = new BashTool({ classifier });

    const result = await tool.execute({ command: "rm file.txt" });

    expect(result).toContain("BLOQUEADO POR CLASIFICADOR DE SEGURIDAD");
    expect(result).toContain("rm file.txt");
    expect(result).toContain("Modifica el filesystem");
    expect(result).toContain("INSTRUCCIONES PARA EL AGENTE");
    expect(mockClassify).toHaveBeenCalledWith("rm file.txt");
  });

  it("should execute when force: true, skipping classifier", async () => {
    const mockClassify = vi.fn();
    const mockLearn = vi.fn().mockResolvedValue(undefined);

    const classifier = new CommandClassifier(overrides, "test-key");
    vi.spyOn(classifier, "classify").mockImplementation(mockClassify);
    vi.spyOn(classifier, "learnOverride").mockImplementation(mockLearn);

    const tool = new BashTool({ classifier });

    const result = await tool.execute({ command: "rm file.txt", force: true });

    // Should not call classify at all
    expect(mockClassify).not.toHaveBeenCalled();
    // Should learn the override
    expect(mockLearn).toHaveBeenCalledWith("rm file.txt", "safe");
    // Should have executed (or at least tried — rm without file is fine)
    expect(result).not.toContain("BLOQUEADO");
  });

  it("should use override instead of classifying when pattern matches", async () => {
    await overrides.add({ pattern: "echo safe", verdict: "safe", reason: "Confío", source: "manual" });

    const classifier = new CommandClassifier(overrides, "test-key");
    const result_classify = await classifier.classify("echo safe");
    expect(result_classify.verdict).toBe("safe");
    expect(result_classify.source).toBe("override");

    const tool = new BashTool({ classifier });

    const result = await tool.execute({ command: "echo safe" });
    expect(result).toContain("safe");
  });

  it("should work without classifier (backward compatible)", async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: "echo hello" });
    expect(result).toContain("hello");
  });

  it("should accept force: true even without classifier", async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: "echo forced", force: true });
    expect(result).toContain("forced");
  });
});