import { stdin, stdout } from "process";
import { AskUserInput } from "./components/ask-user-input.js";
import { CursorPosition, InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";
import { dim } from "./theme.js";

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
  #ephemeral: string | null = null;
  #reading = false;
  #resolve: ((result: unknown) => void) | null = null;

  #prevRows = 0; // filas que ocupó la región viva en el último render
  #prevCursorRow = 0; // fila (0-based) donde quedó el cursor

  #busy = false; // lock para evitar que setStatus redibuje durante printAbove
  #statusDirty = false; // setStatus cambió estando busy → redibujar al unlock
  #pasteBuffer: string | null = null;
  #paddingRight: number;

  /** Si está seteado, Ctrl+C durante la ejecución del agente aborta esta
   * señal en lugar de matar el proceso. */
  #abortSignal: AbortController | null = null;

  constructor(paddingRight: number = 0) {
    this.#paddingRight = paddingRight;
    stdin.on("data", this.#onData);
  }

  /** Registra un AbortController para que Ctrl+C lo aborte durante la
   * ejecución del agente, en lugar de matar el proceso. */
  setAbortController(ctrl: AbortController): void {
    this.#abortSignal = ctrl;
  }

  /** Limpia el AbortController asociado. */
  clearAbortController(): void {
    this.#abortSignal = null;
  }

  /** Adquirir lock de escritura. Mientras está tomado, setStatus solo
   * actualiza #status en memoria, no redibuja (evita race condition con
   * el timer del spinner durante printAbove/writeEphemeral). */
  #lock(): void {
    this.#busy = true;
  }

  #unlock(): void {
    this.#busy = false;
    if (this.#statusDirty) {
      this.#statusDirty = false;
      this.#redraw();
    }
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

  /** Imprime text en el scrollback, por encima de la región viva.
   * El efímero no se pierde: se limpia momentáneamente y se redibuja
   * abajo del texto commiteado. */
  printAbove(text: string): void {
    this.#lock();
    this.#clearLive();
    // Considerar "vacío" después de strippear ANSI, no por text.length
    if (stripAnsi(text).trim().length > 0) {
      const out = this.#wrapIfNeeded(text);
      stdout.write(out);
      if (!out.endsWith("\n")) stdout.write(LF);
    }
    this.#renderLive();
    this.#unlock();
  }

  #wrapIfNeeded(text: string): string {
    if (this.#paddingRight <= 0) return text;
    const maxWidth = (stdout.columns ?? 80) - this.#paddingRight;
    if (maxWidth < 20) return text; // no vale la pena wrappear columnas muy angostas
    return wrapText(text, maxWidth);
  }

  /**
   * Texto efímero: se sobrescribe en cada llamada. Truncado a 1 línea
   * visual (stdout.columns), sin wrapping. Es parte de la región viva.
   */
  writeEphemeral(text: string): void {
    this.#lock();
    this.#ephemeral = text.length > 0 && stripAnsi(text).trim().length > 0
      ? truncateEphemeral(text)
      : null;
    this.#redraw();
    this.#unlock();
  }

  /** Limpia el texto efímero sin dejar rastro. */
  clearEphemeral(): void {
    this.#lock();
    this.#ephemeral = null;
    this.#redraw();
    this.#unlock();
  }

  /** Redibuja la región viva en el lugar (útil tras escribir al scrollback).
   * Toma el lock para que el timer del spinner no interfiera. */
  redrawLive(): void {
    this.#lock();
    this.#clearLive();
    this.#renderLive();
    this.#unlock();
  }

  /** Setea (o limpia con null) la línea de estado encima del editor. */
  setStatus(text: string | null): void {
    this.#status = text;
    if (!this.#busy) {
      this.#redraw();
    } else {
      this.#statusDirty = true;
    }
  }

  /** Pausa la UI y muestra un prompt inline para que el usuario responda
   * una pregunta del agente. Devuelve la respuesta. */
  async askUser(question: string): Promise<string> {
    this.#lock();
    this.#clearLive();
    // Mostrar la pregunta como texto commited
    stdout.write(dim(`\n${question}\n`));
    this.#unlock();

    const component = new AskUserInput();
    component.setPrompt("> Responder (Enter para enviar, vacío para cancelar):");
    return this.readLine(component);
  }

  // ── interno ───────────────────────────────────────────────────────────

  /** Render combinado: efímero (si hay) + status (si hay) + editor. */
  #composeRender(): { out: string; cursorRow: number; cursorCol: number } {
    const lines: string[] = [];
    const ephemeralRows = this.#ephemeral !== null ? 1 : 0;
    const statusRows = this.#status !== null ? 1 : 0;

    if (ephemeralRows) lines.push(this.#ephemeral as string);
    if (statusRows) lines.push(this.#status as string);
    lines.push(this.#live ? this.#live.render() : "");

    const out = lines.join("\n");

    let cursorRow = out.split("\n").length - 1;
    let cursorCol = 0;
    if (this.#live?.getCursorPosition) {
      const cp = this.#live.getCursorPosition();
      cursorRow = cp.row + ephemeralRows + statusRows;
      cursorCol = cp.col;
    }
    return { out, cursorRow, cursorCol };
  }

  /** Sube al tope de la región viva y limpia de ahí hacia abajo (relativo). */
  #clearLive(): void {
    if (this.#prevCursorRow > 0) stdout.write(CUU(this.#prevCursorRow));
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
    // Durante la ejecución del agente, solo dejamos pasar Ctrl+C y Esc
    // para interrupción; el resto del input se ignora.
    if (!this.#reading) {
      // Ctrl+C: \x03. Esc: \x1b. Escape sequences (flechas, etc): \x1b[...]
      // Solo pasamos \x03 y \x1b solo (sin argumentos extra).
      if (raw === "\x03" || raw === "\x1b") {
        this.#processKey(raw);
      }
      return;
    }

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

    if (key.type === "ctrl" && key.key === "c" || key.type === "escape") {
      // Si el agente está corriendo y hay un AbortController registrado,
      // interrumpimos la llamada al LLM en lugar de matar el proceso.
      if (this.#abortSignal) {
        this.#abortSignal.abort();
        // Si estamos en ask_user (reading=true), forzamos que el componente
        // termine con resultado vacío para cancelar la confirmación.
        if (this.#reading && this.#resolve) {
          this.#reading = false;
          const resolve = this.#resolve;
          this.#resolve = null;
          resolve?.("");
        }
        return;
      }
      // Solo Ctrl+C (no Esc) mata el proceso en el prompt normal
      if (key.type === "ctrl" && key.key === "c") {
        stdout.write(CURSOR_SHOW);
        stdin.removeListener("data", this.#onData);
        disableRawMode();
        process.exit(0);
      }
      return;
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

// ── Helpers de ANSI ──────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Trunca text a stdout.columns caracteres visibles (ignorando ANSI),
 *  para garantizar que el efímero nunca wrapee. */
function truncateEphemeral(text: string): string {
  const width = (stdout.columns ?? 80) - 1; // -1 por margen de seguridad
  const stripped = stripAnsi(text);
  if (stripped.length <= width) return text;

  // Avanzar por el string original, salteando secuencias ANSI
  let visible = 0;
  let i = 0;
  while (i < text.length && visible < width) {
    const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (match) {
      i += match[0].length;
      continue;
    }
    visible++;
    i++;
  }
  return text.slice(0, i);
}

/**
 * Word-wrap consciente de ANSI. Respeta saltos de línea existentes y
 * re-aplica códigos de estilo en cada línea resultante para que no se
 * pierdan al cortar.
 */
function wrapText(text: string, maxWidth: number): string {
  const lines = text.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    const wrapped = wrapLine(line, maxWidth);
    result.push(...wrapped);
  }
  return result.join("\n");
}

/** Secuencia ANSI de apertura al inicio de un string, ej: "\x1b[2m". */
const ANSI_LEADING_RE = /^\x1b\[[0-9;]*m/;

function extractLeadingAnsi(s: string): string {
  const m = s.match(ANSI_LEADING_RE);
  return m ? m[0] : "";
}

function extractTrailingAnsi(s: string): string {
  // El cierre de estilo que usamos siempre es \x1b[0m
  if (s.endsWith("\x1b[0m")) return "\x1b[0m";
  return "";
}

function wrapLine(line: string, maxWidth: number): string[] {
  const visibleLen = stripAnsi(line).length;
  if (visibleLen <= maxWidth) return [line];

  const leading = extractLeadingAnsi(line);
  const trailing = extractTrailingAnsi(line);

  // Quitar apertura y cierre para trabajar con el texto limpio
  let inner = line;
  if (leading) inner = inner.slice(leading.length);
  if (trailing) inner = inner.slice(0, inner.length - trailing.length);

  const result: string[] = [];

  while (inner.length > 0) {
    if (stripAnsi(inner).length <= maxWidth) {
      result.push(leading + inner + trailing);
      break;
    }

    // Buscar el último espacio dentro del límite visible
    let spaceIdx = -1;
    let visibleCount = 0;
    for (let i = 0; i < inner.length && visibleCount < maxWidth; i++) {
      const ansiMatch = inner.slice(i).match(ANSI_LEADING_RE);
      if (ansiMatch) {
        i += ansiMatch[0].length - 1;
        continue;
      }
      if (inner[i] === " ") spaceIdx = i;
      visibleCount++;
    }

    let cutIdx: number;
    let skip: number; // cuántos chars saltar al pasar a la siguiente línea

    if (spaceIdx > 0) {
      // Cortar en el espacio: no lo incluimos en la línea, y lo saltamos
      cutIdx = spaceIdx;
      skip = 1; // saltar el espacio mismo
    } else {
      // No hay espacio: cortar justo en maxWidth caracteres visibles
      visibleCount = 0;
      cutIdx = 0;
      for (let i = 0; i < inner.length && visibleCount < maxWidth; i++) {
        const ansiMatch = inner.slice(i).match(ANSI_LEADING_RE);
        if (ansiMatch) {
          i += ansiMatch[0].length - 1;
          continue;
        }
        visibleCount++;
        cutIdx = i + 1;
      }
      skip = 0; // no saltar nada, continuación pegada
    }

    result.push(leading + inner.slice(0, cutIdx) + trailing);
    inner = inner.slice(cutIdx + skip);
  }

  return result.length > 0 ? result : [line];
}

export { Screen, stripAnsi, truncateEphemeral, wrapText };