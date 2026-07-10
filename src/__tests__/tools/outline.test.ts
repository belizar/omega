import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, unlink, mkdir, rmdir } from "fs/promises";
import { join } from "path";
import { OutlineTool } from "../../tools/outline.js";

describe("OutlineTool", () => {
  const testDir = "./test-outline-dir";
  let outlineTool: OutlineTool;

  beforeEach(async () => {
    outlineTool = new OutlineTool();
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(testDir, "test.ts"),
      `import { x } from "./x";
export class Foo {
  bar(): string { return "bar"; }
}`,
      "utf-8",
    );
    await writeFile(
      join(testDir, "otro.ts"),
      `export const PI = 3.14;
export type User = { id: number };`,
      "utf-8",
    );
    await writeFile(
      join(testDir, "not-ts.txt"),
      "hello world",
      "utf-8",
    );
  });

  afterEach(async () => {
    try {
      await unlink(join(testDir, "test.ts"));
      await unlink(join(testDir, "otro.ts"));
      await unlink(join(testDir, "not-ts.txt"));
      await rmdir(testDir);
    } catch {
      // ignore
    }
  });

  it("debe devolver outline de un archivo TS", async () => {
    const result = await outlineTool.execute({ path: join(testDir, "test.ts") });
    expect(result).toContain("test.ts ·");
    expect(result).toContain("imports: ./x");
    expect(result).toContain("export class Foo");
    expect(result).toContain("bar(): string");
  });

  it("debe devolver outline de un directorio", async () => {
    const result = await outlineTool.execute({ path: testDir });
    // outline resuelve el path contra su cwd → el header muestra el path absoluto.
    // Chequeamos el basename, presente tanto en relativo como en absoluto.
    expect(result).toContain("test-outline-dir");
    expect(result).toContain("2 archivos");
    expect(result).toContain("test.ts");
    expect(result).toContain("otro.ts");
    expect(result).toContain("(sin subdirs)");
  });

  it("debe bloquear archivos .env", async () => {
    const result = await outlineTool.execute({ path: ".env" });
    expect(result).toContain("Acceso bloqueado");
  });

  it("debe devolver error para path inválido", async () => {
    const result = await outlineTool.execute({ path: "/no/existe" });
    expect(result).toContain("Error");
  });

  it("debe validar input", async () => {
    const result = await outlineTool.execute({ path: "" } as any);
    expect(result).toContain("Error");
  });
});