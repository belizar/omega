import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { EditTool } from "../../tools/edit.js";

describe("EditTool", () => {
  const testFile = "./test-file-edit.txt";
  let editTool: EditTool;

  beforeEach(() => {
    editTool = new EditTool();
    writeFileSync(testFile, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5", "utf-8");
  });

  afterEach(() => {
    try {
      unlinkSync(testFile);
    } catch {
      // File doesn't exist
    }
  });

  it("should replace exact text in a file", () => {
    const result = editTool.execute({
      path: testFile,
      oldText: "Line 2",
      newText: "Line 2 MODIFIED",
    });
    expect(result).toContain("Editado");
    expect(result).toContain(testFile);

    const content = readFileSync(testFile, "utf-8");
    expect(content).toContain("Line 2 MODIFIED");
    expect(content).not.toContain("Line 2\n");
  });

  it("should fail when text not found (0 occurrences)", () => {
    const result = editTool.execute({
      path: testFile,
      oldText: "This text does not exist",
      newText: "replacement",
    });
    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("should fail on multiple occurrences (ambiguous)", () => {
    const result = editTool.execute({
      path: testFile,
      oldText: "Line",
      newText: "Row",
    });
    expect(result).toContain("Error");
    expect(result).toContain("ambiguous");
    expect(result).toContain("5 times");
  });

  it("should fail on non-existent file", () => {
    const result = editTool.execute({
      path: "./does-not-exist-xyz.txt",
      oldText: "anything",
      newText: "else",
    });
    expect(result).toContain("Error");
    expect(result).toContain("Could not read");
  });

  it("should validate input is an object", () => {
    const result = editTool.execute(null);
    expect(result).toContain("Error");
    expect(result).toContain("must be an object");
  });

  it("should validate that path, oldText, newText are strings", () => {
    const result = editTool.execute({ path: 123, oldText: "a", newText: "b" });
    expect(result).toContain("Error");
    expect(result).toContain("must be strings");
  });

  it("should block editing .env files", () => {
    const result = editTool.execute({
      path: ".env",
      oldText: "KEY=value",
      newText: "KEY=other",
    });
    expect(result).toContain("bloqueado");
  });

  it("should replace text with empty string", () => {
    const result = editTool.execute({
      path: testFile,
      oldText: "Line 3\n",
      newText: "",
    });
    expect(result).toContain("Editado");

    const content = readFileSync(testFile, "utf-8");
    expect(content).not.toContain("Line 3");
    expect(content).toContain("Line 2\nLine 4");
  });

  it("should handle multiline replacements", () => {
    const result = editTool.execute({
      path: testFile,
      oldText: "Line 2\nLine 3",
      newText: "REPLACED\nMULTILINE",
    });
    expect(result).toContain("Editado");

    const content = readFileSync(testFile, "utf-8");
    expect(content).toContain("REPLACED\nMULTILINE");
    expect(content).not.toContain("Line 2\nLine 3");
  });
});