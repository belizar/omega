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

    const classifier = new CommandClassifier(overrides, { apiKey: "test-key" });
    vi.spyOn(classifier, "classify").mockImplementation(mockClassify);

    const tool = new BashTool({ classifier });

    const { output } = await tool.execute({ command: "echo hello" });

    expect(output).toContain("hello");
    expect(mockClassify).toHaveBeenCalledWith("echo hello");
  });

  it("should return BLOQUEADO message when classifier returns dangerous", async () => {
    const mockClassify = vi.fn().mockResolvedValue({
      verdict: "dangerous" as const,
      reason: "Modifica el filesystem",
      source: "classifier" as const,
    });

    const classifier = new CommandClassifier(overrides, { apiKey: "test-key" });
    vi.spyOn(classifier, "classify").mockImplementation(mockClassify);

    const tool = new BashTool({ classifier });

    const { output } = await tool.execute({ command: "rm file.txt" });

    expect(output).toContain("BLOQUEADO POR CLASIFICADOR DE SEGURIDAD");
    expect(output).toContain("rm file.txt");
    expect(output).toContain("Modifica el filesystem");
    expect(output).toContain("INSTRUCCIONES PARA EL AGENTE");
    expect(mockClassify).toHaveBeenCalledWith("rm file.txt");
  });

  it("should execute when force: true, skipping classifier", async () => {
    const mockClassify = vi.fn();

    const classifier = new CommandClassifier(overrides, { apiKey: "test-key" });
    vi.spyOn(classifier, "classify").mockImplementation(mockClassify);

    const tool = new BashTool({ classifier });

    const { output } = await tool.execute({ command: "rm file.txt", force: true });

    expect(mockClassify).not.toHaveBeenCalled();
    expect(output).not.toContain("BLOQUEADO");
  });

  it("should learn override on force when learnEnabled", async () => {
    const classWithLearn = new CommandClassifier(overrides, {
      apiKey: "test-key",
      learnEnabled: true,
    });
    const mockLearn = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(classWithLearn, "learnOverride").mockImplementation(mockLearn);

    const tool = new BashTool({ classifier: classWithLearn });
    await tool.execute({ command: "rm file.txt", force: true });
    expect(mockLearn).toHaveBeenCalledWith("rm file.txt", "safe");
  });

  it("should use override instead of classifying when pattern matches", async () => {
    await overrides.add({
      pattern: "echo safe",
      verdict: "safe",
      reason: "Confío",
      source: "manual",
    });

    const classifier = new CommandClassifier(overrides, { apiKey: "test-key" });
    const result_classify = await classifier.classify("echo safe");
    expect(result_classify.verdict).toBe("safe");
    expect(result_classify.source).toBe("override");

    const tool = new BashTool({ classifier });

    const { output } = await tool.execute({ command: "echo safe" });
    expect(output).toContain("safe");
  });

  it("should work without classifier (backward compatible)", async () => {
    const tool = new BashTool();
    const { output } = await tool.execute({ command: "echo hello" });
    expect(output).toContain("hello");
  });

  it("should accept force: true even without classifier", async () => {
    const tool = new BashTool();
    const { output } = await tool.execute({ command: "echo forced", force: true });
    expect(output).toContain("forced");
  });
});