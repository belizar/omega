import { describe, it, expect, beforeEach } from "vitest";
import { LineEditor } from "../../tui/components/line-editor.js";
import { Key } from "../../tui/decodeKey.js";

// Helpers para simular teclas
const char = (value: string): Key => ({ type: "char", value });
const enter: Key = { type: "enter" };
const backspace: Key = { type: "backspace" };
const del: Key = { type: "delete" };
const left: Key = { type: "left" };
const right: Key = { type: "right" };
const up: Key = { type: "up" };
const down: Key = { type: "down" };
const home: Key = { type: "home" };
const end: Key = { type: "end" };
const ctrl = (key: string): Key => ({ type: "ctrl", key });
const paste = (text: string): Key => ({ type: "paste", text });
const newline: Key = { type: "newline" };

function typeChars(editor: LineEditor, text: string): void {
  for (const c of text) editor.handleKey(char(c));
}

// ── Helpers: formato con barras horizontales ────────────────────────────

const DIM = "\x1b[2m";
const RST = "\x1b[0m";

/** Render esperado: recuadro con box-drawing. Ancho default 80. */
function barContent(buffer: string, width = 80): string {
  const innerW = width - 2; // sin bordes laterales
  const topBar = `${DIM}┌${"─".repeat(innerW)}┐${RST}`;
  const botBar = `${DIM}└${"─".repeat(innerW)}┘${RST}`;
  const promptLen = 2; // "> "
  const indent = " ".repeat(promptLen);
  const lines = buffer.split("\n");
  const content = lines.map((l, i) => {
    const prefix = i === 0 ? "> " : indent;
    const visible = prefix + l;
    const pad = innerW - visible.length;
    return `${DIM}│${RST}` + visible + (pad > 0 ? " ".repeat(pad) : "") + `${DIM}│${RST}`;
  });
  return [topBar, ...content, botBar].join("\n");
}

/** Posición del cursor: row + 1 (borde superior), col = prompt(2) + borde(1) + cursorCol */
function cpos(row: number, cursorCol: number) {
  return { row: row + 1, col: 3 + cursorCol };
}

describe("LineEditor", () => {
  let editor: LineEditor;

  beforeEach(() => {
    editor = new LineEditor();
  });

  // ---- Básico ----

  it("empieza vacío y no done", () => {
    expect(editor.render()).toBe(barContent(""));
    expect(editor.isDone()).toBe(false);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 0));
  });

  it("escribe caracteres y hace commit con enter", () => {
    typeChars(editor, "hola");
    expect(editor.render()).toBe(barContent("hola"));
    expect(editor.getCursorPosition()).toEqual(cpos(0, 4));
    editor.handleKey(enter);
    expect(editor.isDone()).toBe(true);
    expect(editor.getResult()).toBe("hola");
  });

  it("render no incluye el \\n final de commit", () => {
    typeChars(editor, "test");
    editor.handleKey(enter);
    expect(editor.render()).toBe(barContent("test"));
    expect(editor.getResult()).toBe("test");
  });

  // ---- reset ----

  it("reset limpia buffer y done pero conserva historial", () => {
    typeChars(editor, "cmd1");
    editor.handleKey(enter);
    editor.addToHistory(editor.getResult());
    expect(editor.isDone()).toBe(true);

    editor.reset();
    expect(editor.isDone()).toBe(false);
    expect(editor.render()).toBe(barContent(""));
    expect(editor.getCursorPosition()).toEqual(cpos(0, 0));
  });

  // ---- Cursor y movimiento ----

  it("mueve cursor con left/right", () => {
    typeChars(editor, "ab");
    expect(editor.getCursorPosition()).toEqual(cpos(0, 2));
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 1));
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 0));
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 0)); // no pasa del prompt
    editor.handleKey(right);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 1));
  });

  it("left/right no se salen de los bordes", () => {
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 0));
    editor.handleKey(right);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 0));
  });

  it("home/end", () => {
    typeChars(editor, "abc");
    editor.handleKey(home);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 0));
    editor.handleKey(end);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 3));
  });

  // ---- Inserción en medio ----

  it("inserta en posición del cursor, no al final", () => {
    typeChars(editor, "ac");
    editor.handleKey(left);
    editor.handleKey(char("b"));
    expect(editor.render()).toBe(barContent("abc"));
    expect(editor.getResult()).toBe("abc");
  });

  // ---- Backspace y Delete ----

  it("backspace borra carácter anterior al cursor", () => {
    typeChars(editor, "abc");
    editor.handleKey(backspace);
    expect(editor.render()).toBe(barContent("ab"));
    editor.handleKey(left);
    editor.handleKey(backspace);
    expect(editor.render()).toBe(barContent("b"));
  });

  it("delete borra carácter en el cursor", () => {
    typeChars(editor, "abc");
    editor.handleKey(home);
    editor.handleKey(right);
    editor.handleKey(del);
    expect(editor.render()).toBe(barContent("ac"));
  });

  // ---- Multilínea ----

  it("Shift+Enter inserta newline y mueve cursor", () => {
    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    expect(editor.render()).toBe(barContent("linea1\nlinea2"));
    expect(editor.getCursorPosition()).toEqual(cpos(1, 6));
  });

  it("up/down mueven entre líneas en multilínea", () => {
    typeChars(editor, "aa");
    editor.handleKey(newline);
    typeChars(editor, "bbb");
    expect(editor.getCursorPosition()).toEqual(cpos(1, 3));

    editor.handleKey(up);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 2));

    editor.handleKey(down);
    expect(editor.getCursorPosition()).toEqual(cpos(1, 2));
  });

  it("home/end en multilínea operan sobre la línea actual", () => {
    typeChars(editor, "aa");
    editor.handleKey(newline);
    typeChars(editor, "bbb");
    editor.handleKey(up);
    editor.handleKey(home);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 0));
    editor.handleKey(end);
    expect(editor.getCursorPosition()).toEqual(cpos(0, 2));
  });

  // ---- Historial ----

  it("up/down navegan historial desde buffer vacío", () => {
    typeChars(editor, "primer");
    editor.handleKey(enter);
    editor.addToHistory(editor.getResult());
    editor.reset();

    typeChars(editor, "segundo");
    editor.handleKey(enter);
    editor.addToHistory(editor.getResult());
    editor.reset();

    editor.handleKey(up);
    expect(editor.render()).toBe(barContent("segundo"));

    editor.handleKey(up);
    expect(editor.render()).toBe(barContent("primer"));

    editor.handleKey(up);
    expect(editor.render()).toBe(barContent("primer"));

    editor.handleKey(down);
    expect(editor.render()).toBe(barContent("segundo"));

    editor.handleKey(down);
    expect(editor.render()).toBe(barContent(""));
  });

  it("historial preserva draft al navegar", () => {
    typeChars(editor, "borrador");
    editor.handleKey(up);
    expect(editor.render()).toBe(barContent("borrador"));

    editor.addToHistory("previo");
    editor.reset();
    typeChars(editor, "nuevo");
    editor.handleKey(up);
    expect(editor.render()).toBe(barContent("previo"));
    editor.handleKey(down);
    expect(editor.render()).toBe(barContent("nuevo"));
  });

  it("addToHistory no duplica consecutivos", () => {
    editor.addToHistory("cmd");
    editor.addToHistory("cmd");
    editor.addToHistory("otro");
    editor.addToHistory("otro");

    editor.handleKey(up);
    expect(editor.render()).toBe(barContent("otro"));
    editor.handleKey(up);
    expect(editor.render()).toBe(barContent("cmd"));
  });

  // ---- Atajos Ctrl ----

  it("Ctrl+A va a inicio de línea", () => {
    typeChars(editor, "abc");
    editor.handleKey(ctrl("a"));
    expect(editor.getCursorPosition()).toEqual(cpos(0, 0));
  });

  it("Ctrl+E va a fin de línea", () => {
    typeChars(editor, "abc");
    editor.handleKey(home);
    editor.handleKey(ctrl("e"));
    expect(editor.getCursorPosition()).toEqual(cpos(0, 3));
  });

  it("Ctrl+U borra desde inicio de línea hasta cursor", () => {
    typeChars(editor, "abc");
    editor.handleKey(left);
    expect(editor.render()).toBe(barContent("abc"));
    editor.handleKey(ctrl("u"));
    expect(editor.render()).toBe(barContent("c"));
  });

  it("Ctrl+K borra desde cursor hasta fin de línea", () => {
    typeChars(editor, "abc");
    editor.handleKey(left);
    editor.handleKey(left);
    expect(editor.render()).toBe(barContent("abc"));
    editor.handleKey(ctrl("k"));
    expect(editor.render()).toBe(barContent("a"));
  });

  it("Ctrl+W borra palabra hacia atrás", () => {
    typeChars(editor, "hola mundo");
    editor.handleKey(ctrl("w"));
    expect(editor.render()).toBe(barContent("hola "));
    editor.handleKey(ctrl("w"));
    expect(editor.render()).toBe(barContent(""));
  });

  // ---- Paste ----

  it("paste inserta texto multilínea", () => {
    editor.handleKey(paste("linea1\nlinea2\nlinea3"));
    expect(editor.render()).toBe(barContent("linea1\nlinea2\nlinea3"));
    expect(editor.getCursorPosition()).toEqual(cpos(2, 6));
  });

  // ---- Historial con multilínea ----

  it("up desde primera línea multilínea navega historial", () => {
    editor.addToHistory("previo");
    editor.reset();

    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    editor.handleKey(up);
    editor.handleKey(up);
    expect(editor.render()).toBe(barContent("previo"));
  });

  it("down desde última línea multilínea navega historial (vacío -> nada)", () => {
    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    editor.handleKey(down);
    expect(editor.render()).toBe(barContent("linea1\nlinea2"));
  });

  // ---- Integridad del buffer en multilínea (regresión) ----

  it("newline + tipeo no duplica el buffer", () => {
    typeChars(editor, "Primero");
    expect(editor.render()).toBe(barContent("Primero"));
    expect(editor.getResult()).toBe("Primero");

    editor.handleKey(newline);
    expect(editor.render()).toBe(barContent("Primero\n"));
    expect(editor.getCursorPosition().row).toBe(2);
    expect(editor.getCursorPosition().col).toBe(3);

    typeChars(editor, "Segundo");
    expect(editor.render()).toBe(barContent("Primero\nSegundo"));
    expect(editor.getCursorPosition()).toEqual(cpos(1, 7));

    editor.handleKey(newline);
    typeChars(editor, "Tercero");
    expect(editor.render()).toBe(barContent("Primero\nSegundo\nTercero"));

    editor.handleKey(enter);
    expect(editor.getResult()).toBe("Primero\nSegundo\nTercero");
  });

  it("newline + tipeo + backspace mantiene integridad", () => {
    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    editor.handleKey(newline);
    typeChars(editor, "linea3");

    for (let i = 0; i < 6; i++) editor.handleKey(backspace);
    expect(editor.render()).toBe(barContent("linea1\nlinea2\n"));

    editor.handleKey(up);
    editor.handleKey(home);
    editor.handleKey(backspace);
    expect(editor.render()).toBe(barContent("linea1linea2\n"));
  });

  it("newline + navegación con up/down no corrompe buffer", () => {
    typeChars(editor, "a");
    editor.handleKey(newline);
    typeChars(editor, "b");
    editor.handleKey(newline);
    typeChars(editor, "c");

    editor.handleKey(up);
    expect(editor.getCursorPosition().row).toBe(2);
    editor.handleKey(up);
    expect(editor.getCursorPosition().row).toBe(1);
    editor.handleKey(down);
    expect(editor.getCursorPosition().row).toBe(2);
    editor.handleKey(down);
    expect(editor.getCursorPosition().row).toBe(3);

    expect(editor.render()).toBe(barContent("a\nb\nc"));
  });

  it("reset después de multilínea limpia correctamente", () => {
    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    editor.handleKey(enter);

    const result = editor.getResult();
    expect(result).toBe("linea1\nlinea2");
    editor.addToHistory(result);

    editor.reset();
    expect(editor.render()).toBe(barContent(""));
    expect(editor.getCursorPosition()).toEqual(cpos(0, 0));
    expect(editor.isDone()).toBe(false);

    editor.handleKey(up);
    expect(editor.render()).toBe(barContent("linea1\nlinea2"));
  });
});
