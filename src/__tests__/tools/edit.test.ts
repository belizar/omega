import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, unlink } from "fs/promises";
import { EditTool, type EditInput } from "../../tools/edit.js";

describe("EditTool", () => {
  const testFile = "./test-file-edit.txt";
  let editTool: EditTool;

  beforeEach(async () => {
    editTool = new EditTool();
    await writeFile(testFile, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5", "utf-8");
  });

  afterEach(async () => {
    try { await unlink(testFile); } catch { /* */ }
  });

  it("should replace exact text in a file", async () => {
    const result = await editTool.execute({
      path: testFile,
      oldText: "Line 2",
      newText: "Line 2 MODIFIED",
    });
    expect(result).toContain("Editado");
    expect(result).toContain(testFile);

    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("Line 2 MODIFIED");
    expect(content).not.toContain("Line 2\n");
  });

  it("should fail when text not found (0 occurrences) with similar block hint", async () => {
    // Archivo: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    const result = await editTool.execute({
      path: testFile,
      oldText: "This text does not exist",
      newText: "replacement",
    });
    // Ahora findClosest SIEMPRE encuentra la línea más parecida (Dice difuso).
    // "This text does not exist" vs "Line 1", "Line 2", etc. — score bajo (< 0.2)
    // pero siempre muestra el contexto de la más cercana.
    expect(result).toContain("Lo más parecido");
    expect(result).toContain("puede no ser lo que buscás"); // score < 0.2
    expect(result).toContain("línea");
  });

  it("should show closest block with line numbers even for completely unrelated text", async () => {
    // oldText que NO aparece como substring en el archivo
    await writeFile(
      testFile,
      "  import { foo } from './bar';\n\n  export function baz() {\n    return foo();\n  }\n",
      "utf-8",
    );
    const result = await editTool.execute({
      path: testFile,
      oldText: "completely different text\nthat does not exist\n",
      newText: "replacement",
    });
    // findClosest rankea TODAS las líneas por Dice, siempre devuelve la más parecida.
    // "completely different text" tiene score bajo contra cualquier línea, pero igual muestra.
    expect(result).toContain("Lo más parecido");
    expect(result).toContain("puede no ser lo que buscás"); // score < 0.2
    expect(result).toContain("línea");
  });

  it("should show closest block when text partially matches a line", async () => {
    // oldText cuya primera línea no vacía sea "export" → Dice alto contra "export function baz()"
    await writeFile(
      testFile,
      "  import { foo } from './bar';\n\n  export function baz() {\n    return foo();\n  }\n",
      "utf-8",
    );
    const result = await editTool.execute({
      path: testFile,
      oldText: "export\n  return foo();\n",
      newText: "export\n  return qux();\n",
    });
    // "export" tiene Dice alto con "export function baz() {" (muchos bigramas en común)
    // → score >= 0.2 → NO muestra "puede no ser lo que buscás"
    expect(result).toContain("Lo más parecido");
    expect(result).toContain("línea");
    expect(result).not.toContain("puede no ser lo que buscás");
  });

  // ── CAMBIO 1 tests ──

  it("should fail on multiple occurrences showing line numbers", async () => {
    const result = await editTool.execute({
      path: testFile,
      oldText: "Line",
      newText: "Row",
    });
    // Nuevo formato: "El texto aparece 5 veces... es ambiguo. Ocurrencias en líneas: 1, 2, 3, 4, 5"
    expect(result).toContain("ambiguo");
    expect(result).toContain("5 veces");
    expect(result).toContain("líneas: 1, 2, 3, 4, 5");
  });

  it("should fail on empty oldText showing ambiguity", async () => {
    const result = await editTool.execute({
      path: testFile,
      oldText: "",
      newText: "anything",
    });
    // Empty string aparece muchas veces → mensaje de >1 ocurrencias
    expect(result).toContain("ambiguo");
    expect(result).toContain("33 veces");
  });

  // ── CAMBIO 2: flexible whitespace match ──

  it("should match oldText with wrong indentation via flexible fallback", async () => {
    await writeFile(testFile, "    indented line 1\n    indented line 2\n", "utf-8");
    // Modelo escribe oldText SIN indentación (o con menos)
    const result = await editTool.execute({
      path: testFile,
      oldText: "indented line 1\nindented line 2",
      newText: "fixed line 1\nfixed line 2",
    });
    expect(result).toContain("Editado");
    expect(result).toContain("match flexible");

    const content = await readFile(testFile, "utf-8");
    // Debe quedar con la indentación correcta (4 espacios)
    expect(content).toBe("    fixed line 1\n    fixed line 2");
  });

  it("should match oldText with extra indentation via flexible fallback", async () => {
    await writeFile(testFile, "  small indent\n  second line\n", "utf-8");
    // Modelo escribe oldText con MUCHA indentación
    const result = await editTool.execute({
      path: testFile,
      oldText: "      small indent\n      second line",
      newText: "      fixed\n      again",
    });
    expect(result).toContain("Editado");
    expect(result).toContain("match flexible");

    const content = await readFile(testFile, "utf-8");
    // Debe quedar con 2 espacios (la indentación real del archivo)
    // delta = 2 - 6 = -4, newText tenía 6 espacios → se le quitan 4 → 2 espacios
    expect(content).toBe("  fixed\n  again");
  });

  it("should NOT flexible-match when multiple blocks have same trimmed content", async () => {
    // oldText multilínea SIN indentación → exact match da 0 (no es substring)
    // pero flexible match encuentra 2 bloques → cae a CAMBIO 1
    await writeFile(testFile, "  same content\n  same content\n  same content\n", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "same content\nsame content",
      newText: "changed\nchanged",
    });
    // >1 match flexible → cae al CAMBIO 1 (fallo que enseña)
    // findSimilarBlock encuentra "same content" en la línea 1
    expect(result).toContain("Lo más parecido");
  });

  // ── CAMBIO 4: replaceAll ──

  it("should replace all occurrences with replaceAll: true", async () => {
    await writeFile(testFile, "TODO: fix\nblah\nTODO: fix\n", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "TODO: fix",
      newText: "DONE",
      replaceAll: true,
    });
    expect(result).toContain("Editado");
    expect(result).toContain("2 ocurrencias reemplazadas");

    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("DONE\nblah\nDONE\n");
  });

  it("should fail on multiple occurrences without replaceAll", async () => {
    await writeFile(testFile, "dup\nmiddle\ndup\n", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "dup",
      newText: "unique",
    });
    expect(result).toContain("ambiguo");
    expect(result).toContain("2 veces");
    expect(result).toContain("replaceAll: true");
  });

  // ── Tests existentes que deben seguir pasando ──

  it("should fail on non-existent file", async () => {
    const result = await editTool.execute({
      path: "./does-not-exist-xyz.txt",
      oldText: "anything",
      newText: "else",
    });
    expect(result).toContain("Error");
    expect(result).toContain("Could not read");
  });

  it("should validate input is an object", async () => {
    const result = await editTool.execute(null);
    expect(result).toContain("Error");
    expect(result).toContain("must be an object");
  });

  it("should validate that path, oldText, newText are strings", async () => {
    const result = await editTool.execute({ path: 123, oldText: "a", newText: "b" });
    expect(result).toContain("Error");
    expect(result).toContain("must be strings");
  });

  it("should block editing .env files", async () => {
    const result = await editTool.execute({
      path: ".env",
      oldText: "KEY=value",
      newText: "KEY=other",
    });
    expect(result).toContain("bloqueado");
  });

  it("should replace text with empty string", async () => {
    const result = await editTool.execute({
      path: testFile,
      oldText: "Line 3\n",
      newText: "",
    });
    expect(result).toContain("Editado");

    const content = await readFile(testFile, "utf-8");
    expect(content).not.toContain("Line 3");
    expect(content).toContain("Line 2\nLine 4");
  });

  it("should handle multiline replacements", async () => {
    const result = await editTool.execute({
      path: testFile,
      oldText: "Line 2\nLine 3",
      newText: "REPLACED\nMULTILINE",
    });
    expect(result).toContain("Editado");

    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("REPLACED\nMULTILINE");
    expect(content).not.toContain("Line 2\nLine 3");
  });

  it("should replace text with special regex characters", async () => {
    await writeFile(testFile, "const $foo = ${bar};\n(hello) [world]", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "${bar}",
      newText: "${baz}",
    });
    expect(result).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("${baz}");
  });

  it("should replace text containing parentheses and brackets", async () => {
    await writeFile(testFile, "(hello) [world]", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "(hello) [world]",
      newText: "(hi) [earth]",
    });
    expect(result).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("(hi) [earth]");
  });

  it("should replace text with tabs and trailing whitespace", async () => {
    await writeFile(testFile, "line1\t\nline2  \nline3", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "line1\t",
      newText: "line1-mod\t",
    });
    expect(result).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("line1-mod\t");
  });

  it("should replace entire file content", async () => {
    await writeFile(testFile, "only this", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "only this",
      newText: "completely replaced",
    });
    expect(result).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("completely replaced");
  });

  it("should block editing .env.local files", async () => {
    const result = await editTool.execute({
      path: ".env.local",
      oldText: "KEY=value",
      newText: "KEY=other",
    });
    expect(result).toContain("bloqueado");
  });

  it("should block editing .envrc files", async () => {
    const result = await editTool.execute({
      path: ".envrc",
      oldText: "KEY=value",
      newText: "KEY=other",
    });
    expect(result).toContain("bloqueado");
  });

  it("should validate that all required fields are present", async () => {
    const result = await editTool.execute({ path: testFile, oldText: "x" } as unknown as EditInput);
    expect(result).toContain("Error");
    expect(result).toContain("must be strings");
  });

  it("should fail when oldText is missing (undefined)", async () => {
    const result = await editTool.execute({ path: testFile, newText: "y" } as unknown as EditInput);
    expect(result).toContain("Error");
    expect(result).toContain("must be strings");
  });

  it("should replace text at the very beginning of the file", async () => {
    await writeFile(testFile, "START\nmiddle\nend", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "START",
      newText: "BEGINNING",
    });
    expect(result).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("BEGINNING\nmiddle\nend");
  });

  it("should replace text at the very end of the file", async () => {
    await writeFile(testFile, "start\nmiddle\nEND", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "END",
      newText: "FINISH",
    });
    expect(result).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("start\nmiddle\nFINISH");
  });

  it("should handle unicode characters in replacement", async () => {
    await writeFile(testFile, "café\nespañol", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "café",
      newText: "café con leche 🥐",
    });
    expect(result).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("café con leche 🥐");
  });

  it("should handle replacement resulting in more occurrences of old pattern", async () => {
    await writeFile(testFile, "replace me here", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "replace me",
      newText: "replace me and replace me",
    });
    // This succeeds because it matches exactly once in the original content
    expect(result).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("and replace me");
  });

  // ── CAMBIO 5: findClosest difuso ──

  it("should show closest line for typo-like oldText (fuzzy match)", async () => {
    // oldText con una línea parecida pero no exacta: "const z = 99;" vs "const x = 1;"
    await writeFile(testFile, "const x = 1;\nlet y = 2;\n", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "const z = 99;",
      newText: "const z = 99;",
    });
    // Debe mostrar "const x = 1;" como la más parecida con su número de línea
    expect(result).toContain("Lo más parecido");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("← más parecida");
    expect(result).toContain("línea"); // incluye número de línea
  });

  it("should handle empty file gracefully", async () => {
    await writeFile(testFile, "", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "anything",
      newText: "else",
    });
    // Archivo vacío → mensaje razonable, no crash
    expect(result).toContain("empty");
  });

  it("should always return a candidate when file has lines (low score)", async () => {
    // oldText con needle que no comparte bigramas con las líneas del archivo
    await writeFile(testFile, "alpha\nbeta\ngamma\n", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "\n\nxyzzz\n",
      newText: "replaced",
    });
    // needle = "xyzzz", score 0 contra "alpha"/"beta"/"gamma" → < 0.2
    expect(result).toContain("Lo más parecido");
    expect(result).toContain("puede no ser lo que buscás");
  });

  it("should find existing line with high score (exact trim match)", async () => {
    // Caso donde findClosest debe rankear muy alto una línea existente
    await writeFile(testFile, "import { foo } from './bar';\nexport default foo;\n", "utf-8");
    const result = await editTool.execute({
      path: testFile,
      oldText: "import { foo } from './bar';",
      newText: "import { bar } from './foo';",
    });
    // 1 ocurrencia exacta → edita normalmente, no debería pasar por findClosest
    expect(result).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("import { bar } from './foo';");
  });
});
