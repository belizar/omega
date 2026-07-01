import { readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { stdout } from "process";
import { CursorPosition, InputComponent } from "../component.js";
import { Key } from "../decodeKey.js";
import { dim } from "../theme.js";
import { readClipboardImage, saveTempImage } from "../clipboard-image.js";

class LineEditor implements InputComponent<string> {
  #buffer: string;
  #cursor: number; // índice dentro del buffer, 0-based
  #done: boolean;
  #promptStr = "> ";
  #history: string[];
  #historyIndex: number; // -1 = no navegando; 0..len-1 = posición en historia
  #draftBuffer: string; // buffer que se guarda antes de navegar historia
  #draftCursor: number;

  /** Imágenes pendientes pegadas con Ctrl+V. Se consumen desde afuera tras commit. */
  #pendingImages: Array<{ data: Buffer; ext: string; path: string }> = [];

  constructor() {
    this.#buffer = "";
    this.#cursor = 0;
    this.#done = false;
    this.#history = [];
    this.#historyIndex = -1;
    this.#draftBuffer = "";
    this.#draftCursor = 0;
  }

  /** Vuelve a modo edición tras un commit, conservando buffer y cursor.
   * Lo usa el Prompt cuando se cancela un modal y hay que seguir editando
   * la misma línea (ej: tipeaste "/resume", se abrió el picker, apretaste Esc). */
  reopen(): void {
    this.#done = false;
  }

  /** Reinicia el estado para un nuevo input (sin perder el historial). */
  reset(): void {
    this.#buffer = "";
    this.#cursor = 0;
    this.#done = false;
    this.#historyIndex = -1;
    this.#draftBuffer = "";
    this.#draftCursor = 0;
    this.#pendingImages = [];
  }

  // ---- helpers de línea ----

  /** Índice del inicio de la línea donde está el cursor */
  #lineStart(): number {
    const before = this.#buffer.lastIndexOf("\n", this.#cursor - 1);
    return before === -1 ? 0 : before + 1;
  }

  /** Índice del final de la línea donde está el cursor (apunta al \n o al final) */
  #lineEnd(): number {
    const after = this.#buffer.indexOf("\n", this.#cursor);
    return after === -1 ? this.#buffer.length : after;
  }

  /** Cantidad de líneas en el buffer */
  #lineCount(): number {
    let n = 1;
    for (let i = 0; i < this.#buffer.length; i++) {
      if (this.#buffer[i] === "\n") n++;
    }
    return n;
  }

  /** Número de línea (0-based) donde está el cursor */
  #cursorLine(): number {
    let line = 0;
    for (let i = 0; i < this.#cursor; i++) {
      if (this.#buffer[i] === "\n") line++;
    }
    return line;
  }

  /** Columna (0-based) del cursor dentro de su línea */
  #cursorCol(): number {
    return this.#cursor - this.#lineStart();
  }

  /** Largo de la línea actual */
  #currentLineLength(): number {
    return this.#lineEnd() - this.#lineStart();
  }

  /** Mueve el cursor al principio de la línea anterior */
  #moveToPrevLine(): void {
    const ls = this.#lineStart();
    if (ls === 0) return; // ya en primera línea
    const prevEnd = ls - 1; // el \n anterior
    const prevStart = this.#buffer.lastIndexOf("\n", prevEnd - 1);
    const prevLineStart = prevStart === -1 ? 0 : prevStart + 1;
    const prevLineLen = prevEnd - prevLineStart;
    const col = this.#cursor - ls; // columna actual
    this.#cursor = prevLineStart + Math.min(col, prevLineLen);
  }

  /** Mueve el cursor al principio de la línea siguiente */
  #moveToNextLine(): void {
    const le = this.#lineEnd();
    if (le === this.#buffer.length) return; // ya en última línea
    const nextStart = le + 1; // después del \n
    const nextEnd = this.#buffer.indexOf("\n", nextStart);
    const nextLineEnd = nextEnd === -1 ? this.#buffer.length : nextEnd;
    const nextLineLen = nextLineEnd - nextStart;
    const col = this.#cursor - this.#lineStart();
    this.#cursor = nextStart + Math.min(col, nextLineLen);
  }

  /** Busca inicio de palabra hacia atrás desde cursor */
  #prevWordBoundary(): number {
    let i = this.#cursor - 1;
    // saltar whitespace
    while (i >= 0 && this.#buffer[i] === " ") i--;
    // saltar no-whitespace
    while (i >= 0 && this.#buffer[i] !== " " && this.#buffer[i] !== "\n") i--;
    return i + 1;
  }

  // ---- handleKey ----

  handleKey(key: Key): void {
    switch (key.type) {
      case "char":
        this.#insertAtCursor(key.value);
        break;
      case "paste":
        this.#insertAtCursor(key.text);
        break;
      case "newline":
        this.#insertAtCursor("\n");
        break;
      case "backspace":
        this.#backspaceAtCursor();
        break;
      case "delete":
        this.#deleteAtCursor();
        break;
      case "enter":
        this.#commit();
        break;
      case "left":
        if (this.#cursor > 0) this.#cursor--;
        break;
      case "right":
        if (this.#cursor < this.#buffer.length) this.#cursor++;
        break;
      case "home":
        this.#cursor = this.#lineStart();
        break;
      case "end":
        this.#cursor = this.#lineEnd();
        break;
      case "up":
        this.#handleUp();
        break;
      case "down":
        this.#handleDown();
        break;
      case "ctrl":
        this.#handleCtrl(key.key);
        break;
      // escape, tab, unknown → ignorados
    }
  }

  isDone(): boolean {
    return this.#done;
  }

  getResult(): string {
    // devolvemos el buffer sin el \n final que se agrega en el commit
    return this.#buffer.endsWith("\n")
      ? this.#buffer.slice(0, -1)
      : this.#buffer;
  }

  /** Envuelve una línea a W columnas. Si es más larga que W, la parte en
   * múltiples chunks: el primero con el prefijo y el resto sin sangría,
   * igual que haría el terminal con wrap automático. */
  #wrapToWidth(text: string, W: number): string[] {
    if (text.length <= W) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += W) {
      chunks.push(text.slice(i, i + W));
    }
    return chunks;
  }

  render(): string {
    const W = this.#boxWidth();
    const innerW = W - 2; // ancho interno (sin bordes laterales)
    const topBar = dim(`┌${"─".repeat(innerW)}┐`);
    const botBar = dim(`└${"─".repeat(innerW)}┘`);
    const promptLen = this.#promptStr.length;
    const indent = " ".repeat(promptLen);

    const logicalLines = this.#buffer.split("\n");
    const physicalLines: string[] = [];
    for (let i = 0; i < logicalLines.length; i++) {
      const prefix = i === 0 ? this.#promptStr : indent;
      const wrapped = this.#wrapToWidth(prefix + logicalLines[i], innerW);
      physicalLines.push(...wrapped);
    }

    // Cada línea va rodeada por bordes verticales
    const body = physicalLines.map(l => {
      // el contenido visible + bordes debe sumar W
      const visible = l.length;
      const pad = innerW - visible;
      return dim("│") + l + (pad > 0 ? " ".repeat(pad) : "") + dim("│");
    });

    return [topBar, ...body, botBar].join("\n");
  }

  /** Render del mensaje enviado SIN la caja (barras), para ecoarlo en el
   * historial. Así el mensaje no se ve igual que el prompt de input de abajo. */
  renderEcho(): string {
    const indent = " ".repeat(this.#promptStr.length);
    return this.#buffer
      .split("\n")
      .map((l, i) => (i === 0 ? this.#promptStr : indent) + l)
      .join("\n");
  }

  getCursorPosition(): CursorPosition {
    const W = this.#boxWidth();
    const innerW = W - 2; // ancho interno (sin │ bordes)
    const promptLen = this.#promptStr.length;
    const indent = " ".repeat(promptLen);

    const logicalLine = this.#cursorLine();
    const logicalCol = this.#cursorCol();
    const logicalLines = this.#buffer.split("\n");

    // Contar filas físicas que ocupan las líneas lógicas anteriores
    let physicalRow = 0;
    for (let i = 0; i < logicalLine; i++) {
      const prefix = i === 0 ? this.#promptStr : indent;
      const line = prefix + logicalLines[i];
      physicalRow += Math.max(1, Math.ceil(line.length / innerW));
    }

    // En la línea actual, calcular cuántas filas físicas ocupa el texto
    // desde el prefijo hasta la posición del cursor
    const prefix = logicalLine === 0 ? this.#promptStr : indent;
    const textUpToCursor = prefix + logicalLines[logicalLine].slice(0, logicalCol);
    const cursorTotalCol = textUpToCursor.length;
    physicalRow += Math.floor(cursorTotalCol / innerW);
    const col = cursorTotalCol % innerW;

    // +1 por la barra superior, +1 por el borde izquierdo │
    return { row: physicalRow + 1, col: col + 1 };
  }

  /** Ancho de la barra horizontal: usa el ancho completo del terminal. */
  #boxWidth(): number {
    return stdout.columns || 80;
  }

  // ---- privados ----

  #insertAtCursor(text: string): void {
    this.#buffer =
      this.#buffer.slice(0, this.#cursor) +
      text +
      this.#buffer.slice(this.#cursor);
    this.#cursor += text.length;
  }

  #backspaceAtCursor(): void {
    if (this.#cursor === 0) return;
    this.#buffer =
      this.#buffer.slice(0, this.#cursor - 1) +
      this.#buffer.slice(this.#cursor);
    this.#cursor--;
  }

  #deleteAtCursor(): void {
    if (this.#cursor >= this.#buffer.length) return;
    this.#buffer =
      this.#buffer.slice(0, this.#cursor) +
      this.#buffer.slice(this.#cursor + 1);
  }

  #commit(): void {
    this.#done = true;
  }

  #handleUp(): void {
    const totalLines = this.#lineCount();
    const curLine = this.#cursorLine();

    // Si estamos en la primera línea y no hay multilínea, navegar historia
    if (curLine === 0 && totalLines === 1) {
      this.#navigateHistoryUp();
      return;
    }

    // Si estamos en la primera línea del buffer multilínea, navegar historia
    if (curLine === 0 && totalLines > 1) {
      this.#navigateHistoryUp();
      return;
    }

    // Si no, mover cursor a línea anterior
    this.#moveToPrevLine();
  }

  #handleDown(): void {
    const totalLines = this.#lineCount();
    const curLine = this.#cursorLine();

    // Si estamos navegando historia, bajamos en el historial o volvemos al draft
    if (this.#historyIndex >= 0) {
      this.#navigateHistoryDown();
      return;
    }

    // Si estamos en la última línea del buffer, navegar historia
    if (curLine === totalLines - 1) {
      this.#navigateHistoryDown();
      return;
    }

    // Si no, mover cursor a línea siguiente
    this.#moveToNextLine();
  }

  #navigateHistoryUp(): void {
    if (this.#history.length === 0) return;

    // Guardar buffer actual como draft la primera vez
    if (this.#historyIndex === -1) {
      this.#draftBuffer = this.#buffer;
      this.#draftCursor = this.#cursor;
      this.#historyIndex = this.#history.length - 1;
    } else if (this.#historyIndex > 0) {
      this.#historyIndex--;
    } else {
      return; // ya en el más viejo
    }

    this.#buffer = this.#history[this.#historyIndex];
    this.#cursor = this.#buffer.length;
  }

  #navigateHistoryDown(): void {
    if (this.#historyIndex === -1) return;

    if (this.#historyIndex < this.#history.length - 1) {
      this.#historyIndex++;
      this.#buffer = this.#history[this.#historyIndex];
      this.#cursor = this.#buffer.length;
    } else {
      // Volver al draft
      this.#historyIndex = -1;
      this.#buffer = this.#draftBuffer;
      this.#cursor = this.#draftCursor;
    }
  }

  #handleCtrl(key: string): void {
    switch (key) {
      case "a":
        this.#cursor = this.#lineStart();
        break;
      case "e":
        this.#cursor = this.#lineEnd();
        break;
      case "k":
        // borrar desde cursor hasta fin de línea
        this.#deleteRange(this.#cursor, this.#lineEnd());
        break;
      case "u":
        // borrar desde inicio de línea hasta cursor
        this.#deleteRange(this.#lineStart(), this.#cursor);
        break;
      case "v":
        this.#pasteFromClipboard();
        break;
      case "w":
        this.#deleteRange(this.#prevWordBoundary(), this.#cursor);
        break;
      // ctrl+c se maneja en render.ts, así que acá no llega
    }
  }

  /** Intenta pegar una imagen del portapapeles. Si no hay imagen, no hace nada. */
  #pasteFromClipboard(): void {
    try {
      const img = readClipboardImage();
      if (img) {
        const filePath = saveTempImage(img.data, img.ext);
        // Insertar el @path relativo para que expandFileMentions lo procese
        const mention = `@${filePath}`;
        this.#insertAtCursor(mention);
        this.#pendingImages.push({ data: img.data, ext: img.ext, path: filePath });
      }
    } catch {
      // Silencioso: si falla, simplemente no pega nada
    }
  }

  /** Devuelve y limpia las imágenes pendientes pegadas durante este input. */
  consumePendingImages(): Array<{ data: Buffer; ext: string; path: string }> {
    const images = [...this.#pendingImages];
    this.#pendingImages = [];
    return images;
  }

  #deleteRange(from: number, to: number): void {
    if (from >= to) return;
    this.#buffer = this.#buffer.slice(0, from) + this.#buffer.slice(to);
    this.#cursor = from;
  }

  // ---- API pública para file picker ----

  /** Reemplaza un rango del buffer. Útil para que el Prompt inserte
   * el path elegido en el file picker. */
  replaceRange(from: number, to: number, text: string): void {
    this.#buffer = this.#buffer.slice(0, from) + text + this.#buffer.slice(to);
    this.#cursor = from + text.length;
  }

  /** Información de la mención @ activa (la que está justo antes del cursor).
   * Devuelve null si el cursor no está sobre una mención. */
  getAtMention(): { start: number; text: string } | null {
    const atIdx = this.#buffer.lastIndexOf("@", this.#cursor - 1);
    if (atIdx === -1) return null;
    // No es mención si el @ está pegado a una palabra (ej: foo@bar)
    if (atIdx > 0 && /\w/.test(this.#buffer[atIdx - 1])) return null;
    return { start: atIdx, text: this.#buffer.slice(atIdx + 1, this.#cursor) };
  }

  /** Lista archivos en el directorio base del prefijo dado. */
  static listFiles(partial: string): string[] {
    const lastSlash = partial.lastIndexOf("/");
    let dir: string;

    try {
      if (lastSlash === -1) {
        dir = partial === "" ? resolve(".") : ".";
        const prefix = partial;
        const entries = readdirSync(dir);
        return entries
          .filter((e) => e.startsWith(prefix) && e !== "." && e !== "..")
          .map((e) => {
            try { return statSync(join(dir, e)).isDirectory() ? e + "/" : e; }
            catch { return e; }
          });
      } else {
        dir = resolve(partial.slice(0, lastSlash));
        if (partial.lastIndexOf("/") !== partial.length - 1) {
          const prefix = partial.slice(lastSlash + 1);
          const entries = readdirSync(dir);
          return entries
            .filter((e) => e.startsWith(prefix) && e !== "." && e !== "..")
            .map((e) => {
              try { return statSync(join(dir, e)).isDirectory() ? e + "/" : e; }
              catch { return e; }
            });
        } else {
          return readdirSync(dir)
            .filter((e) => e !== "." && e !== "..")
            .map((e) => {
              try { return statSync(join(dir, e)).isDirectory() ? e + "/" : e; }
              catch { return e; }
            });
        }
      }
    } catch {
      return [];
    }
  }

  // ---- API pública para comandos ----

  /** Agrega un comando al historial (lo llama el driver tras cada commit) */
  addToHistory(cmd: string): void {
    // No duplicar consecutivos
    if (this.#history.length > 0 && this.#history[this.#history.length - 1] === cmd) {
      return;
    }
    this.#history.push(cmd);
  }
}

export { LineEditor };
