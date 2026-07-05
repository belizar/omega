import { RunnerEvent } from "../runner.js";
import {
  DisplayAssistantText,
  DisplayToolCall,
  DisplayToolResult,
} from "../tui/components/display-text.js";
import { Spinner } from "../tui/components/spinner.js";
import { Screen } from "../tui/screen.js";
import { dim } from "../tui/theme.js";
import { Frontend } from "./frontend.js";

interface TUIFrontendDeps {
  screen: Screen;
  spinner: Spinner;
  assistantText: DisplayAssistantText;
  toolCallText: DisplayToolCall;
  toolResultText: DisplayToolResult;
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
  #getVerbose: () => boolean;

  constructor(deps: TUIFrontendDeps) {
    this.#screen = deps.screen;
    this.#spinner = deps.spinner;
    this.#assistantText = deps.assistantText;
    this.#toolCallText = deps.toolCallText;
    this.#toolResultText = deps.toolResultText;
    this.#getVerbose = deps.getVerbose;
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
