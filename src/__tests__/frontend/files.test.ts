import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { listDir, readFileContent } from "../../frontend/workspace/files.js";

describe("files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omega-files-"));
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "node_modules")); // ruido: debe esconderse
    await mkdir(join(dir, ".omega"));        // ruido: debe esconderse
    await writeFile(join(dir, "a.txt"), "hola\nmundo\n", "utf-8");
    await writeFile(join(dir, "src", "index.ts"), "export const x = 1;\n", "utf-8");
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("listDir: dirs primero, esconde node_modules/.omega, ordena", () => {
    const d = listDir(dir);
    const names = d.entries.map((e) => e.name);
    expect(names).toEqual(["src", "a.txt"]); // src (dir) antes que a.txt (file)
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".omega");
    expect(d.entries.find((e) => e.name === "src")!.type).toBe("dir");
  });

  it("listDir: navega subdirectorios por path relativo", () => {
    const d = listDir(dir, "src");
    expect(d.path).toBe("src");
    expect(d.entries.map((e) => e.name)).toEqual(["index.ts"]);
  });

  it("readFileContent: devuelve el contenido de texto", () => {
    const f = readFileContent(dir, "a.txt");
    expect(f.content).toBe("hola\nmundo\n");
    expect(f.binary).toBe(false);
    expect(f.truncated).toBe(false);
  });

  it("readFileContent: detecta binario (no devuelve contenido)", async () => {
    await writeFile(join(dir, "bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const f = readFileContent(dir, "bin");
    expect(f.binary).toBe(true);
    expect(f.content).toBe("");
  });

  it("SEGURIDAD: path traversal fuera del cwd tira error", () => {
    expect(() => listDir(dir, "../..")).toThrow(/fuera del workspace/);
    expect(() => readFileContent(dir, "../../etc/passwd")).toThrow(/fuera del workspace/);
    // Un path absoluto a otro lado también se bloquea.
    expect(() => readFileContent(dir, "/etc/hosts")).toThrow(/fuera del workspace/);
  });

  it("SEGURIDAD: un archivo legítimo dentro del cwd sí se lee", () => {
    expect(readFileContent(dir, "src/index.ts").content).toContain("export const x");
  });
});
