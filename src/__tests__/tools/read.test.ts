import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, unlink } from "fs/promises";
import { ReadTool } from "../../tools/read.js";

describe("ReadTool", () => {
  const testFile = "./test-file-read.txt";
  let readTool: ReadTool;

  beforeEach(async () => {
    readTool = new ReadTool();
    const content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    await writeFile(testFile, content, "utf-8");
  });

  afterEach(async () => {
    try { await unlink(testFile); } catch { /* */ }
  });

  it("should read entire file content", async () => {
    const { output } = await readTool.execute({ path: testFile });
    expect(output).toContain("Line 1");
    expect(output).toContain("Line 5");
  });

  it("should read with offset and limit", async () => {
    const { output } = await readTool.execute({ path: testFile, offset: 2, limit: 2 });
    const lines = output.split("\n");
    expect(lines[0]).toBe("Line 2");
    expect(lines[1]).toBe("Line 3");
  });

  it("should handle offset only", async () => {
    const { output } = await readTool.execute({ path: testFile, offset: 3 });
    expect(output).toContain("Line 3");
    expect(output).toContain("Line 4");
    expect(output).toContain("Line 5");
  });

  it("should handle invalid path", async () => {
    const { output } = await readTool.execute({ path: "./non-existent-file.txt" });
    expect(output).toContain("Error");
  });

  it("should validate input type", async () => {
    const { output } = await readTool.execute({ path: "" } as any);
    expect(output).toContain("Error");
  });
});