import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { ReadTool } from "../../tools/read.js";
import { WriteTool } from "../../tools/write.js";
import { EditTool } from "../../tools/edit.js";
import { GrepTool } from "../../tools/grep.js";
import { BashTool } from "../../tools/bash.js";

/**
 * Fase 1 del multi-sesión: las file-tools resuelven paths relativos contra un
 * `cwd` por instancia (no el `process.cwd()` global). Esto es lo que permite
 * que N sesiones tengan cada una su propio workspace en un solo proceso.
 *
 * La prueba de fuego es el AISLAMIENTO: dos tools con cwd distinto, mismo path
 * relativo, tocan archivos distintos.
 */
describe("tools cwd-aware", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(async () => {
    // realpath: en macOS tmpdir cuelga de /var → /private/var (symlink), y bash
    // `pwd` devuelve el path real. Normalizamos para poder comparar.
    dirA = await realpath(await mkdtemp(join(tmpdir(), "omega-cwd-a-")));
    dirB = await realpath(await mkdtemp(join(tmpdir(), "omega-cwd-b-")));
  });

  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it("read resuelve el path relativo contra su cwd", async () => {
    await writeFile(join(dirA, "note.txt"), "hola desde A", "utf-8");
    const read = new ReadTool(200, dirA);
    const result = await read.execute({ path: "note.txt" });
    expect(result).toContain("hola desde A");
  });

  it("aísla: mismo path relativo, cwd distinto → archivos distintos", async () => {
    await writeFile(join(dirA, "note.txt"), "soy A", "utf-8");
    // dirB NO tiene note.txt
    const readA = new ReadTool(200, dirA);
    const readB = new ReadTool(200, dirB);

    expect(await readA.execute({ path: "note.txt" })).toContain("soy A");
    expect(await readB.execute({ path: "note.txt" })).toContain("Error");
  });

  it("write crea el archivo dentro de su cwd, no en el del proceso", async () => {
    const write = new WriteTool(dirA);
    const out = await write.execute({ path: "out.txt", content: "generado" });
    expect(out).toContain("correctamente");
    // El archivo existe en dirA con el contenido esperado
    expect(await readFile(join(dirA, "out.txt"), "utf-8")).toBe("generado");
  });

  it("edit modifica el archivo relativo a su cwd", async () => {
    await writeFile(join(dirA, "code.ts"), "const x = 1;\n", "utf-8");
    const edit = new EditTool(dirA);
    const res = await edit.execute({
      path: "code.ts",
      oldText: "const x = 1;",
      newText: "const x = 42;",
    });
    expect(res).toContain("correctamente");
    expect(await readFile(join(dirA, "code.ts"), "utf-8")).toContain("42");
  });

  it("grep busca dentro de su cwd", async () => {
    await writeFile(join(dirA, "hay.txt"), "AGUJA en A", "utf-8");
    await writeFile(join(dirB, "no.txt"), "otra cosa", "utf-8");
    const grepA = new GrepTool(dirA);
    const grepB = new GrepTool(dirB);

    expect(await grepA.execute({ pattern: "AGUJA" })).toContain("AGUJA");
    expect(await grepB.execute({ pattern: "AGUJA" })).toContain("Sin resultados");
  });

  it("bash corre el comando en su cwd", async () => {
    const bash = new BashTool({ cwd: dirA });
    const result = await bash.execute({ command: "pwd" });
    expect(result.trim()).toBe(dirA);
  });

  it("default sin cwd = process.cwd() (back-compat)", async () => {
    // Sin pasar cwd, sigue apuntando al cwd del proceso: un relativo que existe
    // en el repo (package.json) se lee.
    const read = new ReadTool(200);
    const result = await read.execute({ path: "package.json" });
    expect(result).toContain("omega");
  });
});
