import { describe, it, expect, beforeEach } from "vitest";
import { LineEditor } from "../../tui/components/line-editor.js";
import { Key } from "../../tui/decodeKey.js";

// Helpers para simular teclas (lo que decodeKey devolvería)
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

// ── Helpers para el formato caja ─────────────────────────────────────────
// stdout.columns es undefined en tests → default 80.

const DIM = "\x1b[2m";
const RST = "\x1b[0m";

function box(buffer: string, width = 80): string {
  const innerW = width - 4;
  const h = "─".repeat(width - 2);
  const top = `${DIM}╭${h}╮${RST}`;
  const bottom = `${DIM}╰${h}╯${RST}`;

  const lines = buffer.split("\n");
  const content: string[] = [top];

  for (let i = 0; i < lines.length; i++) {
    const prefix = i === 0 ? "> " : "  ";
    const line = prefix + lines[i];
    const padding = " ".repeat(Math.max(0, innerW - line.length));
    content.push(`${DIM}│${RST} ${line}${padding} ${DIM}│${RST}`);
  }

  content.push(bottom);
  return content.join("\n");
}

/**
 * Posición del cursor en la caja.
 * - row siempre +1 (borde superior).
 * - col: +2 por "│ " + 2 por el prompt/indent = +4 sobre cursorCol.
 *
 * Para línea 0 (con prompt "> "):
 *   colNuevo = 4 + cursorCol
 *   colViejo = 2 + cursorCol  → delta = +2 respecto al test viejo.
 *
 * Para línea >0 (indent "  "):
 *   colNuevo = 4 + cursorCol
 *   colViejo = cursorCol      → delta = +4 respecto al test viejo.
 */
function cposL0(col: number) {
  return { row: 1, col: col + 2 };
}
function cposLn(row: number, col: number) {
  return { row: row + 1, col: col + 4 };
}

describe("LineEditor", () => {
  let editor: LineEditor;

  beforeEach(() => {
    editor = new LineEditor();
  });

  // ---- Básico ----

  it("empieza vacío y no done", () => {
    expect(editor.render()).toBe(box(""));
    expect(editor.isDone()).toBe(false);
    expect(editor.getCursorPosition()).toEqual(cposL0(2));
  });

  it("escribe caracteres y hace commit con enter", () => {
    typeChars(editor, "hola");
    expect(editor.render()).toBe(box("hola"));
    expect(editor.getCursorPosition()).toEqual(cposL0(6));
    editor.handleKey(enter);
    expect(editor.isDone()).toBe(true);
    expect(editor.getResult()).toBe("hola");
  });

  it("render no incluye el \\n final de commit", () => {
    typeChars(editor, "test");
    editor.handleKey(enter);
    expect(editor.render()).toBe(box("test"));
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
    expect(editor.render()).toBe(box(""));
    expect(editor.getCursorPosition()).toEqual(cposL0(2));
  });

  // ---- Cursor y movimiento ----

  it("mueve cursor con left/right", () => {
    typeChars(editor, "ab");
    expect(editor.getCursorPosition()).toEqual(cposL0(4));
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual(cposL0(3));
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual(cposL0(2));
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual(cposL0(2)); // no pasa del prompt
    editor.handleKey(right);
    expect(editor.getCursorPosition()).toEqual(cposL0(3));
  });

  it("left/right no se salen de los bordes", () => {
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual(cposL0(2));
    editor.handleKey(right);
    expect(editor.getCursorPosition()).toEqual(cposL0(2));
  });

  it("home/end", () => {
    typeChars(editor, "abc");
    editor.handleKey(home);
    expect(editor.getCursorPosition()).toEqual(cposL0(2));
    editor.handleKey(end);
    expect(editor.getCursorPosition()).toEqual(cposL0(5));
  });

  // ---- Inserción en medio ----

  it("inserta en posición del cursor, no al final", () => {
    typeChars(editor, "ac");
    editor.handleKey(left);
    editor.handleKey(char("b"));
    expect(editor.render()).toBe(box("abc"));
    expect(editor.getResult()).toBe("abc");
  });

  // ---- Backspace y Delete ----

  it("backspace borra carácter anterior al cursor", () => {
    typeChars(editor, "abc");
    editor.handleKey(backspace);
    expect(editor.render()).toBe(box("ab"));
    editor.handleKey(left);
    editor.handleKey(backspace);
    expect(editor.render()).toBe(box("b"));
  });

  it("delete borra carácter en el cursor", () => {
    typeChars(editor, "abc");
    editor.handleKey(home);
    editor.handleKey(right);
    editor.handleKey(del);
    expect(editor.render()).toBe(box("ac"));
  });

  // ---- Multilínea ----

  it("Shift+Enter inserta newline y mueve cursor", () => {
    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    expect(editor.render()).toBe(box("linea1\nlinea2"));
    expect(editor.getCursorPosition()).toEqual(cposLn(1, 6));
  });

  it("up/down mueven entre líneas en multilínea", () => {
    typeChars(editor, "aa");
    editor.handleKey(newline);
    typeChars(editor, "bbb");
    expect(editor.getCursorPosition()).toEqual(cposLn(1, 3));

    editor.handleKey(up);
    // sube a línea 0, col truncada a 2
    expect(editor.getCursorPosition()).toEqual(cposL0(4));

    editor.handleKey(down);
    // preserva col 2, truncada al largo de línea 1 (3) => 2
    expect(editor.getCursorPosition()).toEqual(cposLn(1, 2));
  });

  it("home/end en multilínea operan sobre la línea actual", () => {
    typeChars(editor, "aa");
    editor.handleKey(newline);
    typeChars(editor, "bbb");
    editor.handleKey(up);
    editor.handleKey(home);
    expect(editor.getCursorPosition()).toEqual(cposL0(2));
    editor.handleKey(end);
    expect(editor.getCursorPosition()).toEqual(cposL0(4));
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
    expect(editor.render()).toBe(box("segundo"));

    editor.handleKey(up);
    expect(editor.render()).toBe(box("primer"));

    editor.handleKey(up);
    expect(editor.render()).toBe(box("primer"));

    editor.handleKey(down);
    expect(editor.render()).toBe(box("segundo"));

    editor.handleKey(down);
    expect(editor.render()).toBe(box(""));
  });

  it("historial preserva draft al navegar", () => {
    typeChars(editor, "borrador");
    editor.handleKey(up);
    expect(editor.render()).toBe(box("borrador"));

    editor.addToHistory("previo");
    editor.reset();
    typeChars(editor, "nuevo");
    editor.handleKey(up);
    expect(editor.render()).toBe(box("previo"));
    editor.handleKey(down);
    expect(editor.render()).toBe(box("nuevo"));
  });

  it("addToHistory no duplica consecutivos", () => {
    editor.addToHistory("cmd");
    editor.addToHistory("cmd");
    editor.addToHistory("otro");
    editor.addToHistory("otro");

    editor.handleKey(up);
    expect(editor.render()).toBe(box("otro"));
    editor.handleKey(up);
    expect(editor.render()).toBe(box("cmd"));
  });

  // ---- Atajos Ctrl ----

  it("Ctrl+A va a inicio de línea", () => {
    typeChars(editor, "abc");
    editor.handleKey(ctrl("a"));
    expect(editor.getCursorPosition()).toEqual(cposL0(2));
  });

  it("Ctrl+E va a fin de línea", () => {
    typeChars(editor, "abc");
    editor.handleKey(home);
    editor.handleKey(ctrl("e"));
    expect(editor.getCursorPosition()).toEqual(cposL0(5));
  });

  it("Ctrl+U borra desde inicio de línea hasta cursor", () => {
    typeChars(editor, "abc");
    editor.handleKey(left); // cursor entre 'b' y 'c'
    expect(editor.render()).toBe(box("abc")); // mover cursor no cambia buffer
    editor.handleKey(ctrl("u")); // borra "ab", deja "c"
    expect(editor.render()).toBe(box("c"));
  });

  it("Ctrl+K borra desde cursor hasta fin de línea", () => {
    typeChars(editor, "abc");
    editor.handleKey(left);
    editor.handleKey(left); // cursor entre 'a' y 'b'
    expect(editor.render()).toBe(box("abc"));
    editor.handleKey(ctrl("k")); // borra "bc", deja "a"
    expect(editor.render()).toBe(box("a"));
  });

  it("Ctrl+W borra palabra hacia atrás", () => {
    typeChars(editor, "hola mundo");
    editor.handleKey(ctrl("w"));
    expect(editor.render()).toBe(box("hola "));
    editor.handleKey(ctrl("w"));
    expect(editor.render()).toBe(box(""));
  });

  // ---- Paste ----

  it("paste inserta texto multilínea", () => {
    editor.handleKey(paste("linea1\nlinea2\nlinea3"));
    expect(editor.render()).toBe(box("linea1\nlinea2\nlinea3"));
    // línea 2 (0-based), 6 chars
    expect(editor.getCursorPosition()).toEqual(cposLn(2, 6));
  });

  // ---- Historial con multilínea ----

  it("up desde primera línea multilínea navega historial", () => {
    editor.addToHistory("previo");
    editor.reset();

    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    editor.handleKey(up); // cursor a línea 0
    editor.handleKey(up); // desde primera línea multilínea -> historial
    expect(editor.render()).toBe(box("previo"));
  });

  it("down desde última línea multilínea navega historial (vacío -> nada)", () => {
    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    editor.handleKey(down);
    expect(editor.render()).toBe(box("linea1\nlinea2"));
  });

  // ---- Integridad del buffer en multilínea (regresión) ----

  it("newline + tipeo no duplica el buffer", () => {
    typeChars(editor, "Primero");
    expect(editor.render()).toBe(box("Primero"));
    expect(editor.getResult()).toBe("Primero");

    editor.handleKey(newline);
    expect(editor.render()).toBe(box("Primero\n"));
    expect(editor.getCursorPosition().row).toBe(2); // línea 1 + borde
    expect(editor.getCursorPosition().col).toBe(4); // 4 + 0

    typeChars(editor, "Segundo");
    expect(editor.render()).toBe(box("Primero\nSegundo"));
    expect(editor.getCursorPosition()).toEqual(cposLn(1, 7));

    editor.handleKey(newline);
    typeChars(editor, "Tercero");
    expect(editor.render()).toBe(box("Primero\nSegundo\nTercero"));

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
    expect(editor.render()).toBe(box("linea1\nlinea2\n"));

    editor.handleKey(up);
    editor.handleKey(home);
    editor.handleKey(backspace);
    expect(editor.render()).toBe(box("linea1linea2\n"));
  });

  it("newline + navegación con up/down no corrompe buffer", () => {
    typeChars(editor, "a");
    editor.handleKey(newline);
    typeChars(editor, "b");
    editor.handleKey(newline);
    typeChars(editor, "c");

    editor.handleKey(up);
    expect(editor.getCursorPosition().row).toBe(2); // línea 1 + borde
    editor.handleKey(up);
    expect(editor.getCursorPosition().row).toBe(1); // línea 0 + borde
    editor.handleKey(down);
    expect(editor.getCursorPosition().row).toBe(2);
    editor.handleKey(down);
    expect(editor.getCursorPosition().row).toBe(3); // línea 2 + borde

    expect(editor.render()).toBe(box("a\nb\nc"));
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
    expect(editor.render()).toBe(box(""));
    expect(editor.getCursorPosition()).toEqual(cposL0(2));
    expect(editor.isDone()).toBe(false);

    editor.handleKey(up);
    expect(editor.render()).toBe(box("linea1\nlinea2"));
  });
});
