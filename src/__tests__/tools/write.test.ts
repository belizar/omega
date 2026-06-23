import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, unlink, rm, writeFile } from "fs/promises";
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

  it("should overwrite existing file with low similarity", async () => {
    await writeTool.execute({ path: testFile, content: "Original" });
    // Contenido completamente diferente → baja similitud → permite
    const result = await writeTool.execute({
      path: testFile,
      content: "Updated\nCompletely\nDifferent\nLines\nHere",
    });
    expect(result).toContain("baja similitud");
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("Updated\nCompletely\nDifferent\nLines\nHere");
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

  // ── CAMBIO 3: similitud ──

  it("should reject write when file exists and content is very similar (change 1 line of many)", async () => {
    // 50 líneas iguales, cambia solo 1
    const oldLines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    await writeFile(testFile, oldLines.join("\n"), "utf-8");

    const newLines = [...oldLines];
    newLines[25] = "line 25 CHANGED";
    const result = await writeTool.execute({
      path: testFile,
      content: newLines.join("\n"),
    });

    expect(result).toContain("ya existe");
    expect(result).toContain("edit");
    expect(result).toContain("líneas son iguales");
  });

  it("should allow overwrite with overwrite: true even if similar", async () => {
    const oldLines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    await writeFile(testFile, oldLines.join("\n"), "utf-8");

    const newLines = [...oldLines];
    newLines[25] = "line 25 CHANGED";
    const result = await writeTool.execute({
      path: testFile,
      content: newLines.join("\n"),
      overwrite: true,
    });

    expect(result).toContain("Sobrescrito");
    expect(result).toContain("overwrite: true");

    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("line 25 CHANGED");
  });

  it("should allow write for new files (does not exist)", async () => {
    // El archivo no existe → write normal, sin chequeo
    const result = await writeTool.execute({
      path: "./brand-new-file.txt",
      content: "fresh content",
    });

    expect(result).toContain("correctamente");
    const fileContent = await readFile("./brand-new-file.txt", "utf-8");
    expect(fileContent).toBe("fresh content");

    // Limpieza del archivo extra
    try { await unlink("./brand-new-file.txt"); } catch { /* */ }
  });

  it("should allow write when similarity is low (completely different content)", async () => {
    await writeFile(testFile, "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc", "utf-8");
    const result = await writeTool.execute({
      path: testFile,
      content: "xxxxxxxxxx\nyyyyyyyyyy\nzzzzzzzzzz",
    });

    expect(result).toContain("baja similitud");
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("xxxxxxxxxx\nyyyyyyyyyy\nzzzzzzzzzz");
  });
});
