import { Context } from "../app-context.js";
import { dispatchCommand, modalCommandsMap } from "../commands/index.js";
import { STATUSLINE_KEY, resolveStatusline } from "../commands/statusline.js";
import { RunnerEvent } from "../runner.js";
import { printHero } from "../tui/hero.js";
import { disableRawMode, enableRawMode } from "../tui/terminal.js";
import {
  DisplayAssistantText,
  DisplayToolCall,
  DisplayToolResult,
} from "../tui/components/display-text.js";
import { LineEditor } from "../tui/components/line-editor.js";
import { Prompt } from "../tui/components/prompt.js";
import { Spinner } from "../tui/components/spinner.js";
import { Screen } from "../tui/screen.js";
import { dim } from "../tui/theme.js";
import { basename } from "path";
import { Frontend, FrontendInput, PastedImage, TurnMetrics } from "./frontend.js";

interface TUIFrontendDeps {
  screen: Screen;
  spinner: Spinner;
  assistantText: DisplayAssistantText;
  toolCallText: DisplayToolCall;
  toolResultText: DisplayToolResult;
  lineEditor: LineEditor;
  ctx: Context;
  modals: typeof modalCommandsMap;
  /** Datos ya recolectados para el banner de arranque. */
  heroInfo: Parameters<typeof printHero>[0];
  /** Lee el flag verbose actual (vive en el Context, cambia con /verbose). */
  getVerbose: () => boolean;
}

/**
 * Implementación de `Frontend` para la terminal. Envuelve las piezas de TUI que
 * antes vivían sueltas dentro de `runTurn` en `index.ts`: spinner, render de
 * texto del assistant, tool calls y resultados.
 *
 * No crea sus dependencias — las recibe (mismas instancias que usa el resto de
 * la TUI durante la migración incremental del seam).
 */
export class TUIFrontend implements Frontend {
  #screen: Screen;
  #spinner: Spinner;
  #assistantText: DisplayAssistantText;
  #toolCallText: DisplayToolCall;
  #toolResultText: DisplayToolResult;
  #lineEditor: LineEditor;
  #ctx: Context;
  #modals: typeof modalCommandsMap;
  #heroInfo: Parameters<typeof printHero>[0];
  #getVerbose: () => boolean;

  constructor(deps: TUIFrontendDeps) {
    this.#screen = deps.screen;
    this.#spinner = deps.spinner;
    this.#assistantText = deps.assistantText;
    this.#toolCallText = deps.toolCallText;
    this.#toolResultText = deps.toolResultText;
    this.#lineEditor = deps.lineEditor;
    this.#ctx = deps.ctx;
    this.#modals = deps.modals;
    this.#heroInfo = deps.heroInfo;
    this.#getVerbose = deps.getVerbose;
  }

  start(): void {
    enableRawMode();
    this.#screen.start(); // engancha el listener de stdin (antes vivía en el ctor)
    printHero(this.#heroInfo);
    // Restaurar statusline si la sesión tiene un formato guardado.
    const savedFormat = this.#ctx.session.getMeta(STATUSLINE_KEY) as
      | string
      | undefined;
    if (savedFormat) {
      this.#screen.setStatusline(dim(resolveStatusline(savedFormat, this.#ctx)));
    }
  }

  stop(): void {
    disableRawMode();
  }

  /**
   * Lee el próximo input del usuario. Resuelve comandos slash y comandos modales
   * (ej. /resume) internamente, y devuelve al loop:
   *  - `message` si el usuario mandó texto para el agente (+ imágenes pegadas),
   *  - `exit` si pidió salir,
   *  - `none` si ya se resolvió (comando/modal) y el loop debe seguir.
   *
   * Mueve acá lo que antes vivía suelto en el while(true) de index.ts: Prompt,
   * readLine, historial, eco, dispatchCommand. La expansión de @ y la visión NO
   * viven acá: son preparación del turno y las hace el loop.
   */
  async nextInput(): Promise<FrontendInput> {
    // ── Type-ahead ──────────────────────────────────────────────────────────
    // TODO lo que se encoló durante el turno se procesa JUNTO, en un solo turno:
    // mensajes tipeados mientras esperabas la misma respuesta son un grupo, así
    // el modelo los ve relacionados (no uno por turno, desconectados). La API no
    // admite dos `user` seguidos, así que "juntos" = concatenados en un mensaje.
    const queued = this.#screen.takeQueue();
    if (queued.length > 0) {
      const batched = queued.join("\n");
      this.#screen.printAbove(`\n${this.#lineEditor.renderEchoOf(batched)}`);
      this.#screen.printBlankLine();
      // Los encolados son solo texto (no hay imágenes pegadas con Ctrl+V).
      return this.#resolveInput(batched, []);
    }

    // Línea a medio tipear sin Enter → precargar el editor del próximo prompt.
    const pending = this.#screen.takePendingLine();
    if (pending) this.#lineEditor.setBuffer(pending);

    // ── Lectura interactiva ─────────────────────────────────────────────────
    const prompt = new Prompt({
      editor: this.#lineEditor,
      ctx: this.#ctx,
      modals: this.#modals,
    });
    const result = await this.#screen.readLine(prompt);

    // Historial: lo tipeado (incluye comandos).
    const typed = this.#lineEditor.getResult();
    if (typed.trim() !== "") {
      this.#lineEditor.addToHistory(typed);
    }

    // Comando modal (ej: /resume) ya hizo su efecto dentro del Prompt. No se
    // ecoa "> /resume"; solo mostramos la confirmación y limpiamos el editor.
    if (result.kind === "modal") {
      this.#lineEditor.reset();
      this.#screen.printAbove(result.message ?? "");
      return { kind: "none" };
    }

    const input = result.text;

    // Eco del input en el scrollback (sin pisar la región viva).
    const echo = this.#lineEditor.renderEcho();
    this.#lineEditor.reset();
    this.#screen.printAbove(`\n${echo}`);
    this.#screen.printBlankLine();

    const pastedImages = this.#lineEditor.consumePendingImages();
    return this.#resolveInput(input, pastedImages);
  }

  /** Resuelve texto de input a un FrontendInput: comando slash → `none`,
   *  `exit`, o `message` para el agente. Compartido entre el path encolado y
   *  el interactivo. */
  async #resolveInput(
    input: string,
    pastedImages: PastedImage[],
  ): Promise<FrontendInput> {
    const outcome = await dispatchCommand(input, this.#ctx);
    // Un comando custom expande a un prompt → se corre como un mensaje normal
    // (pasa por todo el pipeline de turno: file-mentions, visión, historial).
    if (outcome.kind === "expand") {
      return { kind: "message", text: outcome.text, pastedImages: [] };
    }
    if (outcome.kind === "handled") {
      return { kind: "none" };
    }
    if (input === "exit") {
      return { kind: "exit" };
    }
    return { kind: "message", text: input, pastedImages };
  }

  turnStarted(): void {
    this.#spinner.start();
  }

  handleEvent(event: RunnerEvent): void {
    switch (event.type) {
      case "text_stream":
        this.#spinner.stop();
        this.#assistantText.displayStream(event.text);
        break;
      case "text_stream_end":
        this.#assistantText.endStream();
        break;
      case "text":
        this.#spinner.stop();
        this.#assistantText.display(event.text);
        break;
      case "tool_use":
        this.#spinner.stop();
        this.#toolCallText.call(event.name, event.input, this.#getVerbose());
        break;
      case "tool_result":
        this.#toolResultText.result(
          event.output,
          this.#getVerbose(),
          event.rawOutput,
          event.isError,
        );
        this.#spinner.start();
        break;
      // "state" lo consume el loop (persistencia); "ask_user" va por askUser().
    }
  }

  turnEnded(): void {
    this.#spinner.stop();
    this.#screen.redrawLive();
  }

  async askUser(question: string): Promise<string> {
    this.#spinner.stop();
    const answer = await this.#screen.askUser(question);
    this.#spinner.start();
    return answer;
  }

  notify(text: string): void {
    this.#screen.printAbove(dim(text));
  }

  reportMetrics(m: TurnMetrics): void {
    const durationSec = (m.durationMs / 1000).toFixed(1);
    const costStr = m.turnCost < 0.01 ? "<$0.01" : `${m.turnCost.toFixed(2)}`;
    const runningStr = m.totalCost < 0.01 ? "<$0.01" : `${m.totalCost.toFixed(2)}`;

    // Indicadores de thrashing (solo visibles cuando hay algo que reportar).
    const thrashParts: string[] = [];
    if (m.toolErrors > 0) {
      thrashParts.push(`⚠ ${m.toolErrors} errores`);
    }
    if (m.rereads.length > 0) {
      // Resumen compacto: cantidad + top ofensores por basename (no el muro de
      // paths absolutos). Ordenado por cuántas veces se re-leyó cada uno.
      const sorted = [...m.rereads].sort((a, b) => b.count - a.count);
      const top = sorted
        .slice(0, 2)
        .map((r) => `${basename(r.path)}×${r.count}`)
        .join(", ");
      const more = sorted.length > 2 ? ` +${sorted.length - 2}` : "";
      thrashParts.push(`⟳ ${m.rereads.length} re-leídos: ${top}${more}`);
    }
    const thrashStr =
      thrashParts.length > 0 ? ` · ${thrashParts.join(" · ")}` : "";

    const line = `~ ctx: ${m.contextTokens} tk · ${m.toolCalls} tools · in: ${m.inputTokens} · out: ${m.outputTokens} tokens · ${durationSec}s · ${costStr} (total: ${runningStr})${thrashStr}`;
    this.notify(`\n${line}`);
  }

  setAbortController(controller: AbortController): void {
    this.#screen.setAbortController(controller);
  }

  clearAbortController(): void {
    this.#screen.clearAbortController();
  }
}
