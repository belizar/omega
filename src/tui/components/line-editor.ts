import { stdout } from "process";
import { CursorPosition, InputComponent } from "../component.js";
import { Key } from "../decodeKey.js";
import { dim } from "../theme.js";
import { findAtPathCompletion } from "../path-completer.js";

class LineEditor implements InputComponent<string> {
  #buffer: string;
  #cursor: number; // índice dentro del buffer, 0-based
  #done: boolean;
  #promptStr = "> ";
  #history: string[];
  #historyIndex: number; // -1 = no navegando; 0..len-1 = posición en historia
  #draftBuffer: string; // buffer que se guarda antes de navegar historia
  #draftCursor: number;

  // Estado de autocompletado de paths con @
  #completion: {
    atIdx: number;
    prefix: string;
    matches: string[];
    currentIdx: number;
  } | null;

  constructor() {
    this.#buffer = "";
    this.#cursor = 0;
    this.#done = false;
    this.#history = [];
    this.#historyIndex = -1;
    this.#draftBuffer = "";
    this.#draftCursor = 0;
    this.#completion = null;
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
        this.#resetCompletion();
        this.#insertAtCursor(key.value);
        break;
      case "paste":
        this.#resetCompletion();
        this.#insertAtCursor(key.text);
        break;
      case "newline":
        this.#resetCompletion();
        this.#insertAtCursor("\n");
        break;
      case "backspace":
        this.#resetCompletion();
        this.#backspaceAtCursor();
        break;
      case "delete":
        this.#resetCompletion();
        this.#deleteAtCursor();
        break;
      case "enter":
        this.#resetCompletion();
        this.#commit();
        break;
      case "left":
        this.#resetCompletion();
        if (this.#cursor > 0) this.#cursor--;
        break;
      case "right":
        this.#resetCompletion();
        if (this.#cursor < this.#buffer.length) this.#cursor++;
        break;
      case "home":
        this.#resetCompletion();
        this.#cursor = this.#lineStart();
        break;
      case "end":
        this.#resetCompletion();
        this.#cursor = this.#lineEnd();
        break;
      case "up":
        this.#resetCompletion();
        this.#handleUp();
        break;
      case "down":
        this.#resetCompletion();
        this.#handleDown();
        break;
      case "ctrl":
        this.#handleCtrl(key.key);
        break;
      case "tab":
        this.#handleTab();
        break;
      // escape, unknown → ignorados
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

  render(): string {
    const W = this.#boxWidth();
    const bar = dim("─".repeat(W));
    const promptLen = this.#promptStr.length;
    const indent = " ".repeat(promptLen);

    const lines = this.#buffer.split("\n");
    const content = lines.map((l, i) => (i === 0 ? this.#promptStr : indent) + l);

    return [bar, ...content, bar].join("\n");
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
    const line = this.#cursorLine();
    const col = (line === 0 ? this.#promptStr.length : 2) + this.#cursorCol();
    return { row: line + 1, col };
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
    this.#resetCompletion();
    switch (key) {
      case "a":
        this.#cursor = this.#lineStart();
        break;
      case "e":
        this.#cursor = this.#lineEnd();
        break;
      case "u":
        // borrar desde inicio de línea hasta cursor
        this.#deleteRange(this.#lineStart(), this.#cursor);
        break;
      case "k":
        // borrar desde cursor hasta fin de línea
        this.#deleteRange(this.#cursor, this.#lineEnd());
        break;
      case "w":
        this.#deleteRange(this.#prevWordBoundary(), this.#cursor);
        break;
      // ctrl+c se maneja en render.ts, así que acá no llega
    }
  }

  #deleteRange(from: number, to: number): void {
    if (from >= to) return;
    this.#buffer = this.#buffer.slice(0, from) + this.#buffer.slice(to);
    this.#cursor = from;
  }

  #handleTab(): void {
    const result = findAtPathCompletion(this.#buffer, this.#cursor);
    if (!result) {
      this.#resetCompletion();
      return;
    }

    // Si ya estabamos en un ciclo de completado, avanzar al siguiente match
    if (this.#completion && this.#completion.matches === result.matches) {
      this.#completion.currentIdx =
        (this.#completion.currentIdx + 1) % result.matches.length;
    } else {
      this.#completion = {
        atIdx: this.#buffer.lastIndexOf("@", this.#cursor - 1),
        prefix: result.prefix,
        matches: result.matches,
        currentIdx: 0,
      };
    }

    const selected = this.#completion.matches[this.#completion.currentIdx];
    const atIdx = this.#completion.atIdx;

    // Reemplazar desde @+1 hasta cursor con el match seleccionado
    const before = this.#buffer.slice(0, atIdx + 1);
    const after = this.#buffer.slice(this.#cursor);
    this.#buffer = before + this.#completion.prefix + selected + after;
    this.#cursor = atIdx + 1 + this.#completion.prefix.length + selected.length;
  }

  #resetCompletion(): void {
    this.#completion = null;
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
