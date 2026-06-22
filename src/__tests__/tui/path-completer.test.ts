import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve, join } from "path";
import { findAtPathCompletion } from "../../tui/path-completer.js";

describe("findAtPathCompletion", () => {
  const testDir = resolve("./test-fixtures-completion");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, "subdir"), { recursive: true });
    writeFileSync(join(testDir, "app.ts"), "// app");
    writeFileSync(join(testDir, "util.ts"), "// util");
    writeFileSync(join(testDir, "subdir", "helper.ts"), "// helper");
    writeFileSync(join(testDir, ".env"), "SECRET=123");
    writeFileSync(join(testDir, ".editorconfig"), "root = true");
    writeFileSync(join(testDir, "alpha.ts"), "// alpha");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("devuelve null si no hay @ en el buffer", () => {
    expect(findAtPathCompletion("hola mundo", 10)).toBeNull();
  });

  it("devuelve null si @ es parte de un email", () => {
    expect(
      findAtPathCompletion("user@domain.com", 14),
    ).toBeNull();
  });

  it("encuentra el path parcial despues de @", () => {
    const result = findAtPathCompletion(
      `mira @${testDir}/ap`,
      `mira @${testDir}/ap`.length,
    );
    expect(result).not.toBeNull();
    expect(result!.matches).toContain("app.ts");
  });

  it("ordena directorios primero", () => {
    const result = findAtPathCompletion(
      `@${testDir}/`,
      `@${testDir}/`.length,
    );
    expect(result).not.toBeNull();
    const subdirIdx = result!.matches.indexOf("subdir");
    const othersIdx = result!.matches.findIndex(
      (m) => m !== "subdir" && !m.startsWith("."),
    );
    expect(subdirIdx).toBeLessThan(othersIdx);
  });

  it("filtra archivos .env", () => {
    const result = findAtPathCompletion(
      `@${testDir}/.e`,
      `@${testDir}/.e`.length,
    );
    expect(result).not.toBeNull();
    expect(result!.matches).not.toContain(".env");
  });

  it("devuelve multiples matches ordenados alfabeticamente", () => {
    const result = findAtPathCompletion(
      `@${testDir}/a`,
      `@${testDir}/a`.length,
    );
    expect(result).not.toBeNull();
    expect(result!.matches.length).toBeGreaterThanOrEqual(1);
    // Orden alfabetico: app.ts, alpha.ts
    expect(result!.matches).toContain("app.ts");
    expect(result!.matches).toContain("alpha.ts");
  });

  it("devuelve null si el directorio no existe", () => {
    const result = findAtPathCompletion(
      "@noexiste/x",
      "@noexiste/x".length,
    );
    expect(result).toBeNull();
  });
});
