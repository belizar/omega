import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, unlink, rm } from "fs/promises";
import { WriteTool } from "../../tools/write.js";

describe("WriteTool", () => {
  const testFile = "./test-file-write.txt";
  const testDir = "./test-dir-write";
  let writeTool: WriteTool;

  beforeEach(() => {
    writeTool = new WriteTool();
  });

  afterEach(async () => {
    try { await unlink(testFile); } catch { /* */ }
    try { await rm(testDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("should create a new file", async () => {
    const { output } = await writeTool.execute({ path: testFile, content: "Test content", rationale: "test" });
    expect(output).toContain("correctamente");
    const fileContent = await readFile(testFile, "utf-8");
    expect(fileContent).toBe("Test content");
  });

  it("should reject without rationale", async () => {
    const { output } = await writeTool.execute({ path: testFile, content: "Test" } as any);
    expect(output).toContain("rationale");
  });

  it("should overwrite existing file", async () => {
    await writeTool.execute({ path: testFile, content: "Original", rationale: "test" });
    await writeTool.execute({ path: testFile, content: "Updated", rationale: "test" });
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("Updated");
  });

  it("should create nested directories", async () => {
    const nestedPath = `${testDir}/nested/path/file.txt`;
    const { output } = await writeTool.execute({
      path: nestedPath,
      content: "Nested content",
      rationale: "test",
    });
    expect(output).toContain("correctamente");
    const fileContent = await readFile(nestedPath, "utf-8");
    expect(fileContent).toBe("Nested content");
  });

  it("should validate path is not empty", async () => {
    const { output } = await writeTool.execute({ path: "", content: "Test", rationale: "test" });
    expect(output).toContain("Error");
  });

  it("should validate input types", async () => {
    const { output } = await writeTool.execute({ path: 123, content: "Test", rationale: "test" } as any);
    expect(output).toContain("Error");
  });

  it("should handle large content", async () => {
    const largeContent = "x".repeat(10000);
    const { output } = await writeTool.execute({ path: testFile, content: largeContent, rationale: "test" });
    expect(output).toContain("correctamente");
    const fileContent = await readFile(testFile, "utf-8");
    expect(fileContent.length).toBe(10000);
  });

  it("should emit file event with rationale", async () => {
    const { output, events } = await writeTool.execute({
      path: testFile,
      content: "Test",
      rationale: "Creando el archivo de test",
    });
    expect(output).toContain("correctamente");
    expect(events).toBeDefined();
    expect(events!.length).toBeGreaterThanOrEqual(1);
    const fileEvent = events!.find((e) => e.snapshot?.type === "file");
    expect(fileEvent).toBeDefined();
    expect(fileEvent!.snapshot!.text).toBe("Creando el archivo de test");
    expect(fileEvent!.snapshot!.refs!.path).toBe(testFile);
  });

  it("should emit notes events when provided", async () => {
    const { output, events } = await writeTool.execute({
      path: testFile,
      content: "Test",
      rationale: "test",
      notes: [{ type: "decision", text: "Decisión" }, { type: "task", text: "Hacer algo", followUp: "Subtarea" }],
    });
    expect(output).toContain("correctamente");

    const decisionEvent = events!.find((e) => e.snapshot?.type === "decision");
    expect(decisionEvent).toBeDefined();

    const taskEvent = events!.find((e) => e.snapshot?.type === "task" && e.snapshot?.state === "open");
    expect(taskEvent).toBeDefined();

    const followUp = events!.find((e) => e.snapshot?.type === "task" && e.snapshot?.text === "Subtarea");
    expect(followUp).toBeDefined();
    expect(followUp!.snapshot!.threadId).toBe(taskEvent!.snapshot!.threadId);
  });
});