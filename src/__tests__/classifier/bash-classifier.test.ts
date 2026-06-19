import { describe, it, expect, beforeEach, vi } from "vitest";
import { BashTool, type BashConfirmCallback } from "../../tools/bash.js";
import { CommandClassifier } from "../../classifier/classifier.js";
import { OverrideManager } from "../../classifier/overrides.js";

describe("BashTool with classifier", () => {
  let overrides: OverrideManager;

  beforeEach(async () => {
    overrides = await OverrideManager.load(".omega/test-bash-classifier-overrides.json");
  });

  it("should execute command directly when classifier returns safe", async () => {
    const mockClassify = vi.fn().mockResolvedValue({
      verdict: "safe" as const,
      reason: "Comando inofensivo",
      source: "classifier" as const,
    });

    const classifier = new CommandClassifier(overrides, "test-key");
    // Mockear classify
    vi.spyOn(classifier, "classify").mockImplementation(mockClassify);

    const onConfirm = vi.fn();
    const tool = new BashTool({ classifier, onConfirm });

    const result = await tool.execute({ command: "echo hello" });

    expect(result).toContain("hello");
    expect(mockClassify).toHaveBeenCalledWith("echo hello");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("should ask confirmation when classifier returns dangerous and user confirms", async () => {
    const mockClassify = vi.fn().mockResolvedValue({
      verdict: "dangerous" as const,
      reason: "Modifica el filesystem",
      source: "classifier" as const,
    });

    const classifier = new CommandClassifier(overrides, "test-key");
    vi.spyOn(classifier, "classify").mockImplementation(mockClassify);
    vi.spyOn(classifier, "learnOverride").mockResolvedValue(undefined);

    const onConfirm: BashConfirmCallback = vi.fn().mockResolvedValue(true);
    const tool = new BashTool({ classifier, onConfirm });

    const result = await tool.execute({ command: "rm file.txt" });

    expect(result).toContain("rm");
    expect(mockClassify).toHaveBeenCalledWith("rm file.txt");
    expect(onConfirm).toHaveBeenCalled();
    expect(classifier.learnOverride).toHaveBeenCalledWith("rm file.txt", "safe");
  });

  it("should reject when classifier returns dangerous and user declines", async () => {
    const mockClassify = vi.fn().mockResolvedValue({
      verdict: "dangerous" as const,
      reason: "Modifica archivos del proyecto",
      source: "classifier" as const,
    });

    const classifier = new CommandClassifier(overrides, "test-key");
    vi.spyOn(classifier, "classify").mockImplementation(mockClassify);
    vi.spyOn(classifier, "learnOverride").mockResolvedValue(undefined);

    const onConfirm: BashConfirmCallback = vi.fn().mockResolvedValue(false);
    const tool = new BashTool({ classifier, onConfirm });

    const result = await tool.execute({ command: "rm important.txt" });

    expect(result).toContain("Error");
    expect(result).toContain("rechazó");
    expect(mockClassify).toHaveBeenCalledWith("rm important.txt");
    expect(onConfirm).toHaveBeenCalled();
    expect(classifier.learnOverride).toHaveBeenCalledWith("rm important.txt", "dangerous");
  });

  it("should use override instead of classifying when pattern matches", async () => {
    await overrides.add({ pattern: "echo safe", verdict: "safe", reason: "Confío", source: "manual" });

    const classifier = new CommandClassifier(overrides, "test-key");
    const result_classify = await classifier.classify("echo safe");
    expect(result_classify.verdict).toBe("safe");
    expect(result_classify.source).toBe("override");

    const onConfirm = vi.fn();
    const tool = new BashTool({ classifier, onConfirm });

    const result = await tool.execute({ command: "echo safe" });
    expect(result).toContain("safe");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("should work without classifier (backward compatible)", async () => {
    const tool = new BashTool(); // sin opciones
    const result = await tool.execute({ command: "echo hello" });
    expect(result).toContain("hello");
  });
});
