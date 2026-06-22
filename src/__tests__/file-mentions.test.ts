import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve, join } from "path";
import { expandFileMentions } from "../file-mentions.js";

describe("expandFileMentions", () => {
  const testDir = resolve("./test-fixtures-mentions");
  const textFileA = join(testDir, "a.txt");
  const textFileB = join(testDir, "sub/b.txt");
  const envFile = join(testDir, ".env");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "sub"), { recursive: true });
    writeFileSync(textFileA, "contenido de A");
    writeFileSync(textFileB, "contenido de B");
    writeFileSync(envFile, "SECRET=123");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── basicos ─────────────────────────────────────────────────────────

  it("devuelve el texto sin cambios si no hay menciones", () => {
    const result = expandFileMentions("hola mundo");
    expect(result.text).toBe("hola mundo");
    expect(result.expandedFiles).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it("no detecta @ sin slash ni extension (como @usuario)", () => {
    const result = expandFileMentions("hola @usuario como va");
    expect(result.text).toBe("hola @usuario como va");
  });

  it("no detecta email@dominio.com", () => {
    const result = expandFileMentions("contacto@example.com es mi mail");
    expect(result.text).toBe("contacto@example.com es mi mail");
  });

  it("expande un solo archivo con path relativo", () => {
    const result = expandFileMentions(`mira @${textFileA}`);
    expect(result.expandedFiles).toContain("test-fixtures-mentions/a.txt");
    expect(result.text).toContain("contenido de A");
    expect(result.text).toContain("[Archivos referenciados con @:]");
  });

  it("expande multiples archivos", () => {
    const result = expandFileMentions(
      `archivo 1: @${textFileA} y archivo 2: @${textFileB}`,
    );
    expect(result.expandedFiles).toHaveLength(2);
    expect(result.text).toContain("contenido de A");
    expect(result.text).toContain("contenido de B");
  });

  it("deduplica menciones repetidas", () => {
    const result = expandFileMentions(
      `@${textFileA} y otra vez @${textFileA}`,
    );
    expect(result.expandedFiles).toHaveLength(1);
  });

  // ── archivos inexistentes / invalidos ───────────────────────────────

  it("ignora archivos inexistentes", () => {
    const result = expandFileMentions("@noexiste.txt");
    expect(result.expandedFiles).toEqual([]);
    expect(result.text).toBe("@noexiste.txt");
  });

  it("ignora directorios (no expande si es dir)", () => {
    const result = expandFileMentions(`@${testDir}/sub`);
    // sub/ es un directorio, no un archivo
    expect(result.expandedFiles).toEqual([]);
  });

  // ── .env bloqueado ──────────────────────────────────────────────────

  it("bloquea archivos .env", () => {
    const result = expandFileMentions(`@${envFile}`);
    expect(result.expandedFiles).toEqual([]);
    expect(result.text).not.toContain("SECRET");
  });

  // ── archivo grande (truncamiento) ───────────────────────────────────

  it("trunca archivos que exceden MAX_FILE_SIZE", () => {
    const bigFile = join(testDir, "big.txt");
    const bigContent = "x".repeat(150_000);
    writeFileSync(bigFile, bigContent);

    const result = expandFileMentions(`@${bigFile}`);
    expect(result.text).toContain("archivo truncado");
    expect(result.text).not.toContain(bigContent);
  });

  // ── formato de inyeccion ────────────────────────────────────────────

  it("inyecta con header y footer de archivo", () => {
    const result = expandFileMentions(`@${textFileA}`);
    expect(result.text).toContain("--- test-fixtures-mentions/a.txt ---");
    expect(result.text).toContain("--- EOF test-fixtures-mentions/a.txt ---");
  });

  it("preserva el texto original antes del bloque inyectado", () => {
    const result = expandFileMentions(
      `explicame @${textFileA} por favor`,
    );
    expect(result.text).toMatch(/^explicame/);
  });
});
