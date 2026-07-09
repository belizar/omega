import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, unlink } from "fs/promises";
import { ReadTool } from "../../tools/read.js";
import { outlineFile } from "../../tools/outline-extract.js";

describe("ReadTool", () => {
  const testFile = "./test-file-read.txt";
  let readTool: ReadTool;

  beforeEach(async () => {
    readTool = new ReadTool(200);
    const content = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    await writeFile(testFile, content, "utf-8");
  });

  afterEach(async () => {
    try {
      await unlink(testFile);
    } catch {
      // File doesn't exist
    }
  });

  it("should read entire file content", async () => {
    const result = await readTool.execute({ path: testFile });
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 5");
  });

  it("should read with offset and limit", async () => {
    const result = await readTool.execute({ path: testFile, offset: 2, limit: 2 });
    const lines = result.split("\n");
    expect(lines[0]).toBe("Line 2");
    expect(lines[1]).toBe("Line 3");
  });

  it("should handle offset only", async () => {
    const result = await readTool.execute({ path: testFile, offset: 3 });
    expect(result).toContain("Line 3");
    expect(result).toContain("Line 4");
    expect(result).toContain("Line 5");
  });

  it("should handle invalid path", async () => {
    const result = await readTool.execute({ path: "./non-existent-file.txt" });
    expect(result).toContain("Error");
  });

  it("should validate input type", async () => {
    const result = await readTool.execute({
      path: "",
    } as any);
    expect(result).toContain("Error");
  });
});

// ── Empujón estructural (outline push) ─────────────────────────────────

describe("ReadTool — outline push", () => {
  const tsFile = "./test-push-outline.ts";
  let readToolLowThreshold: ReadTool;
  let readToolHighThreshold: ReadTool;

  beforeEach(async () => {
    // Threshold bajo (5 líneas) para que el archivo de prueba lo dispare
    readToolLowThreshold = new ReadTool(5);
    // Threshold alto (99999) para que no dispare
    readToolHighThreshold = new ReadTool(99999);

    const tsContent = `import { foo } from "./foo";

export function sumar(a: number, b: number): number {
  return a + b;
}

export function restar(a: number, b: number): number {
  return a - b;
}

export const MAX = 100;
`;
    await writeFile(tsFile, tsContent, "utf-8");
  });

  afterEach(async () => {
    try {
      await unlink(tsFile);
    } catch {
      // ignore
    }
  });

  it("debe devolver outline (no contenido) para archivo TS grande sin offset/limit", async () => {
    const result = await readToolLowThreshold.execute({ path: tsFile });
    // outline, no contenido
    expect(result).toContain("imports: ./foo");
    expect(result).toContain("export sumar(a: number, b: number): number");
    expect(result).toContain("— Este archivo tiene");
    // La guía del outline pide leer por rango (no el escape hatch full: true).
    expect(result).toContain("offset y limit");
    // NO debe contener el cuerpo
    expect(result).not.toContain("return a + b");
  });

  it("debe devolver contenido completo con full: true", async () => {
    const result = await readToolLowThreshold.execute({
      path: tsFile,
      full: true,
    });
    expect(result).toContain("return a + b");
    expect(result).not.toContain("— Este archivo tiene");
  });

  it("debe devolver el rango con offset/limit (sin outline push)", async () => {
    const result = await readToolLowThreshold.execute({
      path: tsFile,
      offset: 2,
      limit: 2,
    });
    expect(result).toContain("export function sumar");
    expect(result).not.toContain("— Este archivo tiene");
  });

  it("archivo chico bajo threshold: contenido completo", async () => {
    const result = await readToolHighThreshold.execute({ path: tsFile });
    expect(result).toContain("return a + b");
    expect(result).not.toContain("— Este archivo tiene");
  });

  it("archivo no-TS grande: sin outline push (se lee entero)", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`).join("\n");
    const txtFile = "./test-push-nonts.txt";
    await writeFile(txtFile, lines, "utf-8");
    try {
      const result = await readToolLowThreshold.execute({ path: txtFile });
      expect(result).toContain("Line 0");
      expect(result).not.toContain("— Este archivo tiene");
    } finally {
      await unlink(txtFile);
    }
  });
});
