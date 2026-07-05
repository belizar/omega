import { Context } from "../app-context.js";
import { dispatchCommand, modalCommandsMap } from "../commands/index.js";
import { RunnerEvent } from "../runner.js";
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
import { Frontend, FrontendInput } from "./frontend.js";

interface TUIFrontendDeps {
  screen: Screen;
  spinner: Spinner;
  assistantText: DisplayAssistantText;
  toolCallText: DisplayToolCall;
  toolResultText: DisplayToolResult;
  lineEditor: LineEditor;
  ctx: Context;
  modals: typeof modalCommandsMap;
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
    this.#getVerbose = deps.getVerbose;
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

    if (await dispatchCommand(input, this.#ctx)) {
      return { kind: "none" };
    }
    if (input === "exit") {
      return { kind: "exit" };
    }

    const pastedImages = this.#lineEditor.consumePendingImages();
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

  setAbortController(controller: AbortController): void {
    this.#screen.setAbortController(controller);
  }

  clearAbortController(): void {
    this.#screen.clearAbortController();
  }
}
