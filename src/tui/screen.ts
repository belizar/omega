import { stdin, stdout } from "process";
import { AskUserInput } from "./components/ask-user-input.js";
import { CursorPosition, InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";
import { dim, green } from "./theme.js";

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
  #statusline: string | null = null;
  #ephemeral: string | null = null;
  #reading = false;
  #resolve: ((result: unknown) => void) | null = null;

  #prevRows = 0; // filas que ocupó la región viva en el último render
  #prevCursorRow = 0; // fila (0-based) donde quedó el cursor

  #busy = false; // lock para evitar que setStatus redibuje durante printAbove
  #statusDirty = false; // setStatus cambió estando busy → redibujar al unlock
  #pasteBuffer: string | null = null;

  // Type-ahead: input tipeado MIENTRAS el agente trabaja (!#reading).
  #queue: string[] = []; // mensajes confirmados con Enter, a procesar al terminar
  #queueLine = ""; // línea actual sin Enter todavía
  #paddingRight: number;
  #indent: number;

  /** Si está seteado, Ctrl+C durante la ejecución del agente aborta esta
   * señal en lugar de matar el proceso. */
  #abortSignal: AbortController | null = null;

  constructor(paddingRight: number = 0, indent: number = 2) {
    this.#paddingRight = paddingRight;
    this.#indent = indent;
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

  // ── Type-ahead (encolar input mientras el agente trabaja) ───────────────

  /** Acumula una tecla tipeada durante el turno. Enter confirma un mensaje. */
  #enqueueKey(raw: string): void {
    const key = decodeKey(raw);
    switch (key.type) {
      case "enter":
        if (this.#queueLine.trim().length > 0) {
          this.#queue.push(this.#queueLine);
          this.#queueLine = "";
        }
        break;
      case "newline": // Shift+Enter → salto de línea dentro del mensaje
        this.#queueLine += "\n";
        break;
      case "backspace":
        this.#queueLine = this.#queueLine.slice(0, -1);
        break;
      case "char":
        this.#queueLine += key.value;
        break;
      case "paste":
        this.#queueLine += key.text;
        break;
      default:
        return; // flechas, tab, etc.: ignorar sin redibujar
    }
    this.#renderQueueHint();
  }

  /** Dibuja la pista de la cola en la línea efímera (arriba del spinner). */
  #renderQueueHint(): void {
    const parts: string[] = [];
    if (this.#queue.length > 0) parts.push(green(`⏎ ${this.#queue.length} en cola`));
    if (this.#queueLine.length > 0) parts.push(dim("▌ ") + this.#queueLine);
    if (parts.length === 0) {
      this.clearEphemeral();
      return;
    }
    this.writeEphemeral(parts.join(dim(" · ")));
  }

  /** Devuelve y limpia los mensajes encolados (llamado al terminar el turno). */
  takeQueue(): string[] {
    const q = this.#queue;
    this.#queue = [];
    this.clearEphemeral();
    return q;
  }

  /** Devuelve y limpia la línea a medio tipear sin Enter (para precargar el editor). */
  takePendingLine(): string {
    const line = this.#queueLine;
    this.#queueLine = "";
    return line;
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
      let out = this.#wrapIfNeeded(text);
      if (this.#indent > 0) {
        const spaces = " ".repeat(this.#indent);
        out = out
          .split("\n")
          .map((l) => (l.length > 0 ? spaces + l : l))
          .join("\n");
      }
      stdout.write(out);
      if (!out.endsWith("\n")) stdout.write(LF);
    }
    this.#renderLive();
    this.#unlock();
  }

  /** Imprime una línea en blanco real en el scrollback. printAbove() ignora
   * los strings vacíos (a propósito, para los modales), así que el espaciado
   * entre bloques de texto necesita este método aparte. */
  printBlankLine(): void {
    this.#lock();
    this.#clearLive();
    // Línea vacía indentada: los espacios hacen que el blank no colapse visualmente
    stdout.write(" ".repeat(this.#indent) + LF);
    this.#renderLive();
    this.#unlock();
  }

  #wrapIfNeeded(text: string): string {
    if (this.#paddingRight <= 0 && this.#indent <= 0) return text;
    const maxWidth = (stdout.columns ?? 80) - this.#paddingRight - this.#indent;
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

  /** Setea (o limpia con null) el statusline debajo del editor. */
  setStatusline(text: string | null): void {
    this.#statusline = text;
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

    const prevLive = this.#live;
    const component = new AskUserInput();
    component.setPrompt("> Responder (Enter para enviar, vacío para cancelar):");
    const answer = await this.readLine(component);

    this.#live = prevLive;
    this.#redraw();
    return answer;
  }

  // ── interno ───────────────────────────────────────────────────────────

  /** Render combinado: efímero (si hay) + status (si hay) + editor + statusline. */
  #composeRender(): { out: string; cursorRow: number; cursorCol: number } {
    const lines: string[] = [];
    const ephemeralRows = this.#ephemeral !== null ? 1 : 0;
    const statusRows = this.#status !== null ? 1 : 0;
    // statusline solo se muestra si no hay spinner activo
    const statuslineActive = this.#status === null && this.#statusline !== null;
    const statuslineRows = statuslineActive ? 1 : 0;

    if (ephemeralRows) lines.push(this.#ephemeral as string);
    if (statusRows) lines.push(this.#status as string);
    lines.push(this.#live ? this.#live.render() : "");
    if (statuslineActive) lines.push(this.#statusline as string);

    const out = lines.join("\n");

    let cursorRow = out.split("\n").length - 1 - statuslineRows;
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
      // Agente trabajando: Ctrl+C / Esc interrumpen; el resto se ENCOLA
      // (type-ahead) para procesarse cuando el turno termine.
      if (raw === "\x03" || raw === "\x1b") {
        this.#processKey(raw);
        return;
      }
      this.#enqueueKey(raw);
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
      // interrumpimos el turno (Ctrl+C o Esc) en lugar de matar el proceso de
      // omega: aborta la llamada al LLM Y las tools en vuelo — bash mata su
      // proceso hijo al recibir el signal.
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
      // Esc en el prompt (sin turno en curso): lo maneja el componente activo
      // —ej. un select-list de /resume lo usa para cancelar—. Cae al
      // handleKey de abajo. Si no hay componente, no pasa nada.
      if (key.type !== "escape") return;
    }

    if (!this.#live) return;

    this.#live.handleKey(key);

    // Drenar output pendiente del componente (ej. sugerencias de autocompletado)
    // hacia el scrollback, ANTES de redibujar la región viva.
    if (this.#live.takeOutput) {
      const out = this.#live.takeOutput();
      if (out) this.printAbove(out);
    }

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

/**
 * Envuelve una sola línea (sin \n) a `maxWidth` chars visibles, consciente de
 * ANSI. Clave: re-aplica el estado de estilo ACTIVO en el punto de corte al
 * inicio de cada continuación (no el estilo inicial de la línea). Así una línea
 * con varios estilos —ej: barra azul + texto bold— envuelve conservando el
 * estilo correcto en cada tramo, en vez de arrastrar el primer color.
 */
function wrapLine(line: string, maxWidth: number): string[] {
  if (stripAnsi(line).length <= maxWidth) return [line];

  const RESET = "\x1b[0m";

  // Parsear en "celdas": cada char visible con el ANSI que lo precede.
  const cells: { ansi: string; ch: string }[] = [];
  let pending = "";
  for (let i = 0; i < line.length; ) {
    const m = line.slice(i).match(/^\x1b\[[0-9;]*m/);
    if (m) {
      pending += m[0];
      i += m[0].length;
      continue;
    }
    cells.push({ ansi: pending, ch: line[i] });
    pending = "";
    i++;
  }

  // Acumula el estado SGR activo; un reset (\x1b[0m / \x1b[m) lo limpia.
  const step = (state: string, seq: string): string => {
    if (!seq) return state;
    let s = state;
    for (const mm of seq.matchAll(/\x1b\[[0-9;]*m/g)) {
      s = mm[0] === "\x1b[0m" || mm[0] === "\x1b[m" ? "" : s + mm[0];
    }
    return s;
  };

  const out: string[] = [];
  let i = 0;
  let stateAtStart = "";
  while (i < cells.length) {
    // Llenar hasta maxWidth, recordando el último espacio para cortar en palabra.
    let j = i;
    let width = 0;
    let lastSpace = -1;
    while (j < cells.length && width < maxWidth) {
      if (cells[j].ch === " ") lastSpace = j;
      width++;
      j++;
    }
    let cut = j;
    let skipSpace = false;
    if (j < cells.length && lastSpace > i) {
      cut = lastSpace;
      skipSpace = true;
    }

    let piece = stateAtStart;
    let state = stateAtStart;
    for (let k = i; k < cut; k++) {
      piece += cells[k].ansi + cells[k].ch;
      state = step(state, cells[k].ansi);
    }
    if (state) piece += RESET; // cerrar estilo abierto al final del tramo
    out.push(piece);

    stateAtStart = state; // la continuación arranca con el estilo activo acá
    i = skipSpace ? cut + 1 : cut;
  }

  return out.length > 0 ? out : [line];
}

export { Screen, stripAnsi, truncateEphemeral, wrapText };