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
    const content = "Test content";
    const result = await writeTool.execute({ path: testFile, content });
    expect(result).toContain("correctamente");
    const fileContent = await readFile(testFile, "utf-8");
    expect(fileContent).toBe(content);
  });

  it("should overwrite existing file", async () => {
    await writeTool.execute({ path: testFile, content: "Original" });
    await writeTool.execute({ path: testFile, content: "Updated" });
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("Updated");
  });

  it("should create nested directories", async () => {
    const nestedPath = `${testDir}/nested/path/file.txt`;
    const result = await writeTool.execute({
      path: nestedPath,
      content: "Nested content",
    });
    expect(result).toContain("correctamente");
    const fileContent = await readFile(nestedPath, "utf-8");
    expect(fileContent).toBe("Nested content");
  });

  it("should validate path is not empty", async () => {
    const result = await writeTool.execute({ path: "", content: "Test" });
    expect(result).toContain("Error");
  });

  it("should validate input types", async () => {
    const result = await writeTool.execute({
      path: 123,
      content: "Test",
    } as any);
    expect(result).toContain("Error");
  });

  it("should handle large content", async () => {
    const largeContent = "x".repeat(10000);
    const result = await writeTool.execute({ path: testFile, content: largeContent });
    expect(result).toContain("correctamente");
    const fileContent = await readFile(testFile, "utf-8");
    expect(fileContent.length).toBe(10000);
  });
});
