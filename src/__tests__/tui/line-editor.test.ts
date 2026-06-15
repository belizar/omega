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

describe("LineEditor", () => {
  let editor: LineEditor;

  beforeEach(() => {
    editor = new LineEditor();
  });

  // ---- Básico ----

  it("empieza vacío y no done", () => {
    expect(editor.render()).toBe("> ");
    expect(editor.isDone()).toBe(false);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 2 });
  });

  it("escribe caracteres y hace commit con enter", () => {
    typeChars(editor, "hola");
    expect(editor.render()).toBe("> hola");
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 6 });
    editor.handleKey(enter);
    expect(editor.isDone()).toBe(true);
    expect(editor.getResult()).toBe("hola");
  });

  it("render no incluye el \\n final de commit", () => {
    typeChars(editor, "test");
    editor.handleKey(enter);
    // render no debería tener salto extra
    expect(editor.render()).toBe("> test");
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
    expect(editor.render()).toBe("> ");
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 2 });
    // historial debería persistir (no se verifica directamente, pero up debería traer cmd1)
  });

  // ---- Cursor y movimiento ----

  it("mueve cursor con left/right", () => {
    typeChars(editor, "ab");
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 4 });
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 3 });
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 2 });
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 2 }); // no pasa del prompt
    editor.handleKey(right);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 3 });
  });

  it("left/right no se salen de los bordes", () => {
    editor.handleKey(left);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 2 });
    editor.handleKey(right);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 2 });
  });

  it("home/end", () => {
    typeChars(editor, "abc");
    editor.handleKey(home);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 2 });
    editor.handleKey(end);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 5 });
  });

  // ---- Inserción en medio ----

  it("inserta en posición del cursor, no al final", () => {
    typeChars(editor, "ac");
    editor.handleKey(left); // cursor entre 'a' y 'c'
    editor.handleKey(char("b"));
    expect(editor.render()).toBe("> abc");
    expect(editor.getResult()).toBe("abc");
  });

  // ---- Backspace y Delete ----

  it("backspace borra carácter anterior al cursor", () => {
    typeChars(editor, "abc");
    editor.handleKey(backspace);
    expect(editor.render()).toBe("> ab");
    editor.handleKey(left);
    editor.handleKey(backspace);
    expect(editor.render()).toBe("> b");
  });

  it("delete borra carácter en el cursor", () => {
    typeChars(editor, "abc");
    editor.handleKey(home);
    editor.handleKey(right); // cursor sobre 'b'
    editor.handleKey(del);
    expect(editor.render()).toBe("> ac");
  });

  // ---- Multilínea ----

  it("Shift+Enter inserta newline y mueve cursor", () => {
    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    expect(editor.render()).toBe("> linea1\nlinea2");
    expect(editor.getCursorPosition()).toEqual({ row: 1, col: 6 });
  });

  it("up/down mueven entre líneas en multilínea", () => {
    typeChars(editor, "aa");
    editor.handleKey(newline);
    typeChars(editor, "bbb");
    // cursor al final: línea 1, col 3 (sin prompt, es línea > 0)
    expect(editor.getCursorPosition()).toEqual({ row: 1, col: 3 });

    editor.handleKey(up);
    // sube a línea 0, columna truncada a 2 + 2 del prompt = 4
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 4 });

    // down desde línea 0 NO siendo última línea: mueve a línea siguiente
    editor.handleKey(down);
    // preserva col 2 de línea 0, truncada al largo de línea 1 (3) => 2
    expect(editor.getCursorPosition()).toEqual({ row: 1, col: 2 });
  });

  it("home/end en multilínea operan sobre la línea actual", () => {
    typeChars(editor, "aa");
    editor.handleKey(newline);
    typeChars(editor, "bbb");
    editor.handleKey(up);
    editor.handleKey(home);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 2 });
    editor.handleKey(end);
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 4 });
  });

  // ---- Historial ----

  it("up/down navegan historial desde buffer vacío", () => {
    // Simulamos comandos previos
    typeChars(editor, "primer");
    editor.handleKey(enter);
    editor.addToHistory(editor.getResult());
    editor.reset();

    typeChars(editor, "segundo");
    editor.handleKey(enter);
    editor.addToHistory(editor.getResult());
    editor.reset();

    // Buffer vacío, up debería traer "segundo"
    editor.handleKey(up);
    expect(editor.render()).toBe("> segundo");

    // Otro up trae "primer"
    editor.handleKey(up);
    expect(editor.render()).toBe("> primer");

    // Up de nuevo no cambia (ya en el más viejo)
    editor.handleKey(up);
    expect(editor.render()).toBe("> primer");

    // Down vuelve a "segundo"
    editor.handleKey(down);
    expect(editor.render()).toBe("> segundo");

    // Down vuelve al draft (vacío)
    editor.handleKey(down);
    expect(editor.render()).toBe("> ");
  });

  it("historial preserva draft al navegar", () => {
    typeChars(editor, "cmd1");
    editor.handleKey(enter);
    editor.addToHistory(editor.getResult());
    editor.reset();

    typeChars(editor, "borrador");
    editor.handleKey(up); // navega a "cmd1"
    expect(editor.render()).toBe("> cmd1");

    editor.handleKey(down); // vuelve al borrador
    expect(editor.render()).toBe("> borrador");
  });

  it("addToHistory no duplica consecutivos", () => {
    editor.addToHistory("x");
    editor.addToHistory("x");
    editor.addToHistory("y");
    editor.addToHistory("x");

    // Solo podemos verificar indirectamente con up
    editor.handleKey(up);
    expect(editor.render()).toBe("> x"); // el último "x"
    editor.handleKey(up);
    expect(editor.render()).toBe("> y");
    editor.handleKey(up);
    expect(editor.render()).toBe("> x"); // el primer "x"
  });

  // ---- Ctrl atajos ----

  it("Ctrl+A va a inicio de línea", () => {
    typeChars(editor, "abc");
    editor.handleKey(ctrl("a"));
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 2 });
  });

  it("Ctrl+E va a fin de línea", () => {
    typeChars(editor, "abc");
    editor.handleKey(home);
    editor.handleKey(ctrl("e"));
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 5 });
  });

  it("Ctrl+U borra desde inicio de línea hasta cursor", () => {
    typeChars(editor, "abc");
    editor.handleKey(left);
    editor.handleKey(ctrl("u"));
    expect(editor.render()).toBe("> c");
  });

  it("Ctrl+K borra desde cursor hasta fin de línea", () => {
    typeChars(editor, "abc");
    editor.handleKey(home);
    editor.handleKey(right);
    editor.handleKey(ctrl("k"));
    expect(editor.render()).toBe("> a");
  });

  it("Ctrl+W borra palabra hacia atrás", () => {
    typeChars(editor, "hola mundo");
    editor.handleKey(ctrl("w"));
    expect(editor.render()).toBe("> hola ");
    editor.handleKey(ctrl("w"));
    expect(editor.render()).toBe("> ");
  });

  // ---- Paste ----

  it("paste inserta texto multilínea", () => {
    editor.handleKey(paste("foo\nbar"));
    expect(editor.render()).toBe("> foo\nbar");
    expect(editor.getCursorPosition()).toEqual({ row: 1, col: 3 });
  });

  // ---- Multilínea + historial ----

  it("up desde primera línea multilínea navega historial", () => {
    // Agregar un comando al historial
    typeChars(editor, "hist-cmd");
    editor.handleKey(enter);
    editor.addToHistory(editor.getResult());
    editor.reset();

    // Escribir multilínea
    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");

    // Mover cursor a primera línea
    editor.handleKey(up);
    expect(editor.getCursorPosition().row).toBe(0);

    // Up desde primera línea -> historial
    editor.handleKey(up);
    expect(editor.render()).toBe("> hist-cmd");
  });

  it("down desde última línea multilínea navega historial (vacío -> nada)", () => {
    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    // cursor en última línea
    editor.handleKey(down); // debería intentar historial, pero está vacío
    expect(editor.render()).toBe("> linea1\nlinea2"); // sin cambios
  });

  // ---- Integridad del buffer en multilínea (regresión) ----

  it("newline + tipeo no duplica el buffer", () => {
    // Reproduce el escenario: escribir, insertar newline, seguir escribiendo.
    // El buffer debe reflejar exactamente lo tipeado, sin duplicaciones.
    typeChars(editor, "Primero");
    expect(editor.render()).toBe("> Primero");
    expect(editor.getResult()).toBe("Primero");

    editor.handleKey(newline);
    // Después del newline: buffer = "Primero\n", cursor al final
    expect(editor.render()).toBe("> Primero\n");
    expect(editor.getCursorPosition().row).toBe(1);
    expect(editor.getCursorPosition().col).toBe(0);

    typeChars(editor, "Segundo");
    // Buffer: "Primero\nSegundo"
    expect(editor.render()).toBe("> Primero\nSegundo");
    expect(editor.getCursorPosition()).toEqual({ row: 1, col: 7 });

    // Insertar otro newline y más texto
    editor.handleKey(newline);
    typeChars(editor, "Tercero");
    expect(editor.render()).toBe("> Primero\nSegundo\nTercero");

    // Commit y verificar getResult
    editor.handleKey(enter);
    expect(editor.getResult()).toBe("Primero\nSegundo\nTercero");
  });

  it("newline + tipeo + backspace mantiene integridad", () => {
    typeChars(editor, "linea1");
    editor.handleKey(newline);
    typeChars(editor, "linea2");
    editor.handleKey(newline);
    typeChars(editor, "linea3");

    // backspace hasta borrar "linea3"
    for (let i = 0; i < 6; i++) editor.handleKey(backspace);
    expect(editor.render()).toBe("> linea1\nlinea2\n");

    // Borrar el newline entre linea1 y linea2
    editor.handleKey(up); // subir a linea2
    editor.handleKey(home); // inicio de linea2
    editor.handleKey(backspace); // borrar el \n, uniendo linea1 y linea2
    expect(editor.render()).toBe("> linea1linea2\n");
  });

  it("newline + navegación con up/down no corrompe buffer", () => {
    typeChars(editor, "a");
    editor.handleKey(newline);
    typeChars(editor, "b");
    editor.handleKey(newline);
    typeChars(editor, "c");

    // Navegar hacia arriba y abajo varias veces
    editor.handleKey(up);
    expect(editor.getCursorPosition().row).toBe(1);
    editor.handleKey(up);
    expect(editor.getCursorPosition().row).toBe(0);
    editor.handleKey(down);
    expect(editor.getCursorPosition().row).toBe(1);
    editor.handleKey(down);
    expect(editor.getCursorPosition().row).toBe(2);

    // El buffer no debería haber cambiado
    expect(editor.render()).toBe("> a\nb\nc");
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
    expect(editor.render()).toBe("> ");
    expect(editor.getCursorPosition()).toEqual({ row: 0, col: 2 });
    expect(editor.isDone()).toBe(false);

    // El historial debe conservar el comando multilínea
    editor.handleKey(up);
    expect(editor.render()).toBe("> linea1\nlinea2");
  });
});
