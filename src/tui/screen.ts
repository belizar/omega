import { stdin, stdout } from "process";
import { InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";

// ── Secuencias de escape ANSI ─────────────────────────────────────────

const CSI = "\x1b[";
const CUU = (n: number) => `${CSI}${n}A`; // Cursor Up n rows
const CUF = (n: number) => `${CSI}${n}C`; // Cursor Forward n cols
const ED0 = `${CSI}0J`; // Erase Display: cursor → end
const CR = "\r";
const LF = "\n";
const CURSOR_SHOW = `${CSI}?25h`;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Renderer persistente del prompt fijo abajo. A diferencia del viejo run()
 * (que era transitorio: manejaba un componente, lo commiteaba y moría), Screen
 * mantiene el componente vivo en la última línea y expone:
 *
 *   - readLine(component): espera input sin destruir el componente.
 *   - printAbove(text):    imprime text en el scrollback, ARRIBA del editor.
 *   - setStatus(text):     línea de estado (spinner) justo encima del editor.
 *
 * Todo el output del programa (texto del agente, tools, métricas, comandos)
 * debe pasar por printAbove; escribir directo a stdout pisaría el editor.
 *
 * Posicionamiento RELATIVO (inmune a scroll): nos movemos siempre relativo a
 * donde está el cursor, nunca con posiciones absolutas (\x1b7/\x1b8).
 */
class Screen {
  #live: InputComponent<unknown> | null = null;
  #status: string | null = null;
  #reading = false;
  #resolve: ((result: unknown) => void) | null = null;

  #prevRows = 0; // filas que ocupó la región viva en el último render
  #prevCursorRow = 0; // fila (0-based) donde quedó el cursor
  #streamingLines = 0; // líneas visuales que ocupó el último printAboveRaw

  #pasteBuffer: string | null = null;

  constructor() {
    stdin.on("data", this.#onData);
  }

  /** Espera a que el componente termine (isDone). Lo deja vivo abajo. */
  readLine<T>(component: InputComponent<T>): Promise<T> {
    this.#live = component as InputComponent<unknown>;
    this.#reading = true;
    this.#redraw();
    return new Promise<T>((resolve) => {
      this.#resolve = (result) => resolve(result as T);
    });
  }

  /** Imprime text en el scrollback, por encima de la región viva. */
  printAbove(text: string): void {
    this.#streamingLines = 0;
    this.#clearLive();
    if (text.length > 0) {
      stdout.write(text);
      if (!text.endsWith("\n")) stdout.write(LF);
    }
    this.#renderLive();
  }

  /**
   * Imprime texto sin forzar LF para streaming typewriter.
   * Cada llamada borra la versión anterior del texto y la reemplaza.
   * El texto siempre queda en su propia línea, arriba del editor.
   */
  printAboveRaw(text: string): void {
    // Borramos el editor viejo + las líneas del chunk anterior
    this.#clearLive(this.#streamingLines);
    if (text.length > 0) {
      stdout.write(text + LF);
    }
    // Cuántas líneas visuales ocupa este texto (para limpiar en el próximo chunk)
    this.#streamingLines = text.length > 0 ? this.#countVisualLines(text) : 0;
    this.#renderLive();
  }

  // Cuenta cuántas líneas ocupa un texto en la terminal, considerando wrapping
  #countVisualLines(text: string): number {
    const width = stdout.columns ?? 80;
    let lines = 0;
    for (const line of text.split("\n")) {
      lines += Math.max(1, Math.ceil(line.length / width));
    }
    return lines;
  }

  /** Reinicia el tracking de líneas de streaming (llamado al hacer printAbove). */
  resetStreamingLines(): void {
    this.#streamingLines = 0;
  }

  /** Setea (o limpia con null) la línea de estado encima del editor. */
  setStatus(text: string | null): void {
    this.#status = text;
    this.#redraw();
  }

  // ── interno ───────────────────────────────────────────────────────────

  /** Render combinado: línea de estado (si hay) + componente vivo. */
  #composeRender(): { out: string; cursorRow: number; cursorCol: number } {
    const lines: string[] = [];
    const statusRows = this.#status !== null ? 1 : 0;
    if (statusRows) lines.push(this.#status as string);
    lines.push(this.#live ? this.#live.render() : "");
    const out = lines.join("\n");

    let cursorRow = out.split("\n").length - 1;
    let cursorCol = 0;
    if (this.#live?.getCursorPosition) {
      const cp = this.#live.getCursorPosition();
      cursorRow = cp.row + statusRows;
      cursorCol = cp.col;
    }
    return { out, cursorRow, cursorCol };
  }

  /** Sube al tope de la región viva y limpia de ahí hacia abajo (relativo).
   * @param extraRows líneas adicionales a borrar arriba de la región viva. */
  #clearLive(extraRows = 0): void {
    const up = (this.#prevRows > 0 && this.#prevCursorRow > 0)
      ? this.#prevCursorRow + extraRows
      : extraRows;
    if (up > 0) stdout.write(CUU(up));
    stdout.write(CR);
    stdout.write(ED0);
  }

  /** Escribe la región viva en la posición actual del cursor y lo ubica. */
  #renderLive(): void {
    const { out, cursorRow, cursorCol } = this.#composeRender();
    stdout.write(out);
    const rows = out.split("\n").length;
    const up = rows - 1 - cursorRow;
    if (up > 0) stdout.write(CUU(up));
    stdout.write(CR + (cursorCol > 0 ? CUF(cursorCol) : ""));
    this.#prevRows = rows;
    this.#prevCursorRow = cursorRow;
  }

  /** Redibujo en el lugar (tecla, cambio de estado). */
  #redraw(): void {
    this.#clearLive();
    this.#renderLive();
  }

  #onData = (raw: string): void => {
    if (!this.#reading) return; // ignoramos input mientras el agente trabaja

    if (this.#pasteBuffer !== null) {
      this.#pasteBuffer += raw;
      if (this.#pasteBuffer.includes(PASTE_END)) {
        const text = this.#pasteBuffer
          .replace(/^\x1b\[200~/, "")
          .replace(/\x1b\[201~$/, "");
        this.#pasteBuffer = null;
        this.#processKey(text);
      }
      return;
    }

    if (raw.includes(PASTE_START)) {
      const idx = raw.indexOf(PASTE_START);
      if (idx > 0) this.#processKey(raw.slice(0, idx));
      this.#pasteBuffer = raw.slice(idx);
      if (this.#pasteBuffer.includes(PASTE_END)) {
        const text = this.#pasteBuffer
          .replace(/^\x1b\[200~/, "")
          .replace(/\x1b\[201~$/, "");
        this.#pasteBuffer = null;
        this.#processKey(text);
      }
      return;
    }

    this.#processKey(raw);
  };

  #processKey(keyStr: string): void {
    const key = decodeKey(keyStr);

    if (key.type === "ctrl" && key.key === "c") {
      stdout.write(CURSOR_SHOW);
      stdin.removeListener("data", this.#onData);
      disableRawMode();
      process.exit(0);
    }

    if (!this.#live) return;

    this.#live.handleKey(key);
    this.#redraw();

    if (this.#live.isDone()) {
      this.#reading = false;
      const result = this.#live.getResult();
      const resolve = this.#resolve;
      this.#resolve = null;
      resolve?.(result);
    }
  }
}

export { Screen };
