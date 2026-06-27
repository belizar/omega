import { describe, it, expect } from "vitest";
import { outlineFile, outlineDir } from "../../outline/extract.js";

// ── outlineFile ───────────────────────────────────────────────────────

describe("outlineFile", () => {
  it("debe devolver firmas con params/return y rangos correctos, sin cuerpos", () => {
    const content = `import { foo } from "./foo";
import { bar } from "../bar";

export class MiClase {
  #privado: string;

  constructor(x: string) {
    this.#privado = x;
  }

  async fetchData(url: string): Promise<Response> {
    const res = await fetch(url);
    return res;
  }

  metodoNormal(a: number, b: number): number {
    return a + b;
  }

  get valor(): string {
    return this.#privado;
  }
}

export function saludar(nombre: string): string {
  return "Hola " + nombre;
}

export type Usuario = { id: number; nombre: string };`;

    const result = outlineFile("test.ts", content);

    // Cabecera
    expect(result).toContain("test.ts ·");

    // Imports agrupados
    expect(result).toContain("imports: ./foo, ../bar");
    expect(result).toMatch(/imports:.*\[1-2\]/);

    // Clase
    expect(result).toContain("export class MiClase");
    expect(result).toMatch(/class MiClase\s+\[/);

    // Métodos de la clase (con indentación)
    expect(result).toContain("#privado: string");
    expect(result).toContain("constructor(x: string)");
    expect(result).toContain("async fetchData(url: string): Promise<Response>");
    expect(result).toContain("metodoNormal(a: number, b: number): number");
    expect(result).toContain("get valor()");

    // Función
    expect(result).toContain("export saludar(nombre: string): string");

    // Type
    expect(result).toContain("export type Usuario");

    // Los cuerpos NO deben aparecer
    expect(result).not.toContain("this.#privado = x");
    expect(result).not.toContain("const res = await fetch");
    expect(result).not.toContain("return a + b");
    expect(result).not.toContain('return "Hola "');
  });

  it("debe devolver mensaje de no-soportado para archivos no-TS", () => {
    const result = outlineFile("test.py", "print('hello')");
    expect(result).toContain("no es un archivo TS/JS");
  });

  it("debe manejar archivos sin declaraciones top-level", () => {
    const result = outlineFile("empty.ts", "// solo un comentario\n");
    expect(result).toContain("empty.ts ·");
  });

  it("debe mostrar enums, interfaces y consts", () => {
    const content = `
export enum Color { Rojo, Verde }

export interface Persona {
  nombre: string;
  edad: number;
}

export const PI = 3.14;
export const MAX_SIZE: number = 100;
`;
    const result = outlineFile("types.ts", content);

    expect(result).toContain("export enum Color");
    expect(result).toContain("export interface Persona");
    expect(result).toContain("export const PI");
    expect(result).toContain("export const MAX_SIZE: number");
  });
});

// ── outlineDir ─────────────────────────────────────────────────────────

describe("outlineDir", () => {
  it("debe listar exports top-level de cada archivo y subdirs", () => {
    // Explicar qué va a pasar con el dir src/tools/ real
    const result = outlineDir("src/tools");

    // Cabecera
    expect(result).toContain("src/tools ·");
    expect(result).toContain("archivos");

    // Debe listar archivos conocidos con sus exports
    expect(result).toContain("read.ts");
    expect(result).toContain("write.ts");
    expect(result).toContain("edit.ts");
    expect(result).toContain("bash.ts");
    expect(result).toContain("outline.ts");
    expect(result).toContain("tool.ts");
    expect(result).toContain("env-guard.ts");
    expect(result).toContain("grep.ts");
    expect(result).toContain("ask-user.ts");

    // Debe listar subdirs (no hay en src/tools/, así que "(sin subdirs)")
    expect(result).toContain("(sin subdirs)");
  });

  it("debe listar subdirectorios cuando existen", () => {
    const result = outlineDir("src/outline");
    expect(result).toContain("src/outline · 1 archivos");
    expect(result).toContain("extract.ts");
    expect(result).toContain("(sin subdirs)");
  });

  it("debe manejar un directorio vacío sin crashear", () => {
    const { mkdirSync, rmdirSync } = require("fs");
    const emptyDir = "./test-empty-outline-dir";
    mkdirSync(emptyDir);
    try {
      const result = outlineDir(emptyDir);
      expect(result).toContain("0 archivos");
    } finally {
      rmdirSync(emptyDir);
    }
  });
});
