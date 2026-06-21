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
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "Line 2",
      newText: "Line 2 MODIFIED",
      rationale: "test edit",
    });
    expect(output).toContain("Editado");
    expect(output).toContain(testFile);

    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("Line 2 MODIFIED");
    expect(content).not.toContain("Line 2\n");
  });

  it("should reject when rationale is missing", async () => {
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "Line 2",
      newText: "Line 2 MODIFIED",
    } as EditInput);
    expect(output).toContain("rationale");
  });

  it("should reject when rationale is empty", async () => {
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "Line 2",
      newText: "Line 2 MODIFIED",
      rationale: "",
    });
    expect(output).toContain("rationale");
  });

  it("should fail when text not found (0 occurrences)", async () => {
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "This text does not exist",
      newText: "replacement",
      rationale: "test",
    });
    expect(output).toContain("Error");
    expect(output).toContain("not found");
  });

  it("should fail on multiple occurrences (ambiguous)", async () => {
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "Line",
      newText: "Row",
      rationale: "test",
    });
    expect(output).toContain("Error");
    expect(output).toContain("ambiguous");
    expect(output).toContain("5 times");
  });

  it("should fail on non-existent file", async () => {
    const { output } = await editTool.execute({
      path: "./does-not-exist-xyz.txt",
      oldText: "anything",
      newText: "else",
      rationale: "test",
    });
    expect(output).toContain("Error");
    expect(output).toContain("Could not read");
  });

  it("should validate input is an object", async () => {
    const { output } = await editTool.execute(null);
    expect(output).toContain("Error");
    expect(output).toContain("must be an object");
  });

  it("should validate that path, oldText, newText are strings", async () => {
    const { output } = await editTool.execute({ path: 123, oldText: "a", newText: "b", rationale: "test" } as any);
    expect(output).toContain("Error");
    expect(output).toContain("must be strings");
  });

  it("should block editing .env files", async () => {
    const { output } = await editTool.execute({
      path: ".env",
      oldText: "KEY=value",
      newText: "KEY=other",
      rationale: "test",
    });
    expect(output).toContain("bloqueado");
  });

  it("should replace text with empty string", async () => {
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "Line 3\n",
      newText: "",
      rationale: "test",
    });
    expect(output).toContain("Editado");

    const content = await readFile(testFile, "utf-8");
    expect(content).not.toContain("Line 3");
    expect(content).toContain("Line 2\nLine 4");
  });

  it("should handle multiline replacements", async () => {
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "Line 2\nLine 3",
      newText: "REPLACED\nMULTILINE",
      rationale: "test",
    });
    expect(output).toContain("Editado");

    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("REPLACED\nMULTILINE");
    expect(content).not.toContain("Line 2\nLine 3");
  });

  it("should replace text with special regex characters", async () => {
    await writeFile(testFile, "const $foo = ${bar};\n(hello) [world]", "utf-8");
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "${bar}",
      newText: "${baz}",
      rationale: "test",
    });
    expect(output).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("${baz}");
  });

  it("should replace text containing parentheses and brackets", async () => {
    await writeFile(testFile, "(hello) [world]", "utf-8");
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "(hello) [world]",
      newText: "(hi) [earth]",
      rationale: "test",
    });
    expect(output).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("(hi) [earth]");
  });

  it("should replace text with tabs and trailing whitespace", async () => {
    await writeFile(testFile, "line1\t\nline2  \nline3", "utf-8");
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "line1\t",
      newText: "line1-mod\t",
      rationale: "test",
    });
    expect(output).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("line1-mod\t");
  });

  it("should replace entire file content", async () => {
    await writeFile(testFile, "only this", "utf-8");
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "only this",
      newText: "completely replaced",
      rationale: "test",
    });
    expect(output).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("completely replaced");
  });

  it("should block editing .env.local files", async () => {
    const { output } = await editTool.execute({
      path: ".env.local",
      oldText: "KEY=value",
      newText: "KEY=other",
      rationale: "test",
    });
    expect(output).toContain("bloqueado");
  });

  it("should block editing .envrc files", async () => {
    const { output } = await editTool.execute({
      path: ".envrc",
      oldText: "KEY=value",
      newText: "KEY=other",
      rationale: "test",
    });
    expect(output).toContain("bloqueado");
  });

  it("should fail on empty oldText", async () => {
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "",
      newText: "anything",
      rationale: "test",
    });
    expect(output).toContain("Error");
    expect(output).toContain("ambiguous");
  });

  it("should validate that all required fields are present", async () => {
    const { output } = await editTool.execute({ path: testFile, oldText: "x" } as unknown as EditInput);
    expect(output).toContain("Error");
    expect(output).toContain("must be strings");
  });

  it("should fail when oldText is missing (undefined)", async () => {
    const { output } = await editTool.execute({ path: testFile, newText: "y" } as unknown as EditInput);
    expect(output).toContain("Error");
    expect(output).toContain("must be strings");
  });

  it("should replace text at the very beginning of the file", async () => {
    await writeFile(testFile, "START\nmiddle\nend", "utf-8");
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "START",
      newText: "BEGINNING",
      rationale: "test",
    });
    expect(output).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("BEGINNING\nmiddle\nend");
  });

  it("should replace text at the very end of the file", async () => {
    await writeFile(testFile, "start\nmiddle\nEND", "utf-8");
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "END",
      newText: "FINISH",
      rationale: "test",
    });
    expect(output).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toBe("start\nmiddle\nFINISH");
  });

  it("should handle unicode characters in replacement", async () => {
    await writeFile(testFile, "café\nespañol", "utf-8");
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "café",
      newText: "café con leche 🥐",
      rationale: "test",
    });
    expect(output).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("café con leche 🥐");
  });

  it("should handle replacement resulting in more occurrences of old pattern", async () => {
    await writeFile(testFile, "replace me here", "utf-8");
    const { output } = await editTool.execute({
      path: testFile,
      oldText: "replace me",
      newText: "replace me and replace me",
      rationale: "test",
    });
    expect(output).toContain("Editado");
    const content = await readFile(testFile, "utf-8");
    expect(content).toContain("and replace me");
  });

  it("should emit file event with rationale", async () => {
    const { output, events } = await editTool.execute({
      path: testFile,
      oldText: "Line 1",
      newText: "Line 1 changed",
      rationale: "Arreglé el bug de la línea 1",
    });
    expect(output).toContain("Editado");
    expect(events).toBeDefined();
    expect(events!.length).toBeGreaterThanOrEqual(1);
    const fileEvent = events!.find((e) => e.snapshot?.type === "file");
    expect(fileEvent).toBeDefined();
    expect(fileEvent!.snapshot!.text).toBe("Arreglé el bug de la línea 1");
    expect(fileEvent!.snapshot!.refs!.path).toBe(testFile);
  });

  it("should emit notes events when provided", async () => {
    const { output, events } = await editTool.execute({
      path: testFile,
      oldText: "Line 5",
      newText: "Line 5 changed",
      rationale: "test",
      notes: [
        { type: "decision", text: "Usar camelCase" },
        { type: "gotcha", text: "Cuidado con el encoding", followUp: "Documetar encoding" },
      ],
    });
    expect(output).toContain("Editado");
    expect(events).toBeDefined();

    const decisionEvent = events!.find((e) => e.snapshot?.type === "decision");
    expect(decisionEvent).toBeDefined();
    expect(decisionEvent!.snapshot!.text).toBe("Usar camelCase");

    const gotchaEvent = events!.find((e) => e.snapshot?.type === "gotcha");
    expect(gotchaEvent).toBeDefined();

    const followUpTask = events!.find((e) => e.snapshot?.type === "task" && e.snapshot?.text === "Documetar encoding");
    expect(followUpTask).toBeDefined();
    expect(followUpTask!.snapshot!.threadId).toBe(gotchaEvent!.snapshot!.threadId);
  });
});