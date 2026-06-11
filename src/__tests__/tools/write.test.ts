import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, unlinkSync, rmSync } from "fs";
import { WriteTool } from "../../tools/write.js";

describe("WriteTool", () => {
  const testFile = "./test-file-write.txt";
  const testDir = "./test-dir-write";
  let writeTool: WriteTool;

  beforeEach(() => {
    writeTool = new WriteTool();
  });

  afterEach(() => {
    try {
      unlinkSync(testFile);
    } catch {
      // File doesn't exist
    }
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Dir doesn't exist
    }
  });

  it("should create a new file", () => {
    const content = "Test content";
    const result = writeTool.execute({ path: testFile, content });
    expect(result).toContain("correctamente");
    const fileContent = readFileSync(testFile, "utf-8");
    expect(fileContent).toBe(content);
  });

  it("should overwrite existing file", () => {
    writeTool.execute({ path: testFile, content: "Original" });
    writeTool.execute({ path: testFile, content: "Updated" });
    const content = readFileSync(testFile, "utf-8");
    expect(content).toBe("Updated");
  });

  it("should create nested directories", () => {
    const nestedPath = `${testDir}/nested/path/file.txt`;
    const result = writeTool.execute({
      path: nestedPath,
      content: "Nested content",
    });
    expect(result).toContain("correctamente");
    const fileContent = readFileSync(nestedPath, "utf-8");
    expect(fileContent).toBe("Nested content");
  });

  it("should validate path is not empty", () => {
    const result = writeTool.execute({ path: "", content: "Test" });
    expect(result).toContain("Error");
  });

  it("should validate input types", () => {
    const result = writeTool.execute({
      path: 123,
      content: "Test",
    } as any);
    expect(result).toContain("Error");
  });

  it("should handle large content", () => {
    const largeContent = "x".repeat(10000);
    const result = writeTool.execute({ path: testFile, content: largeContent });
    expect(result).toContain("correctamente");
    const fileContent = readFileSync(testFile, "utf-8");
    expect(fileContent.length).toBe(10000);
  });
});
