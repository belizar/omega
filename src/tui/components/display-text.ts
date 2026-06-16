import { cyan, dim, gray } from "../theme.js";
import { Screen } from "../screen.js";

interface DisplayText {
  display(text: string): void;
}

/**
 * Los display imprimen ARRIBA de la región viva (vía screen.printAbove), no
 * directo a stdout, así no pisan el editor fijo abajo. Cada uno aplica su
 * estilo.
 */
class DisplayAssistantText implements DisplayText {
  #screen: Screen;
  #streamingBuffer = "";
  #streaming = false;

  constructor(screen: Screen) {
    this.#screen = screen;
  }

  /** Muestra un chunk de texto (modo streaming). Acumula en buffer y
   * va imprimiendo incrementalmente sin LF. */
  displayStream(chunk: string): void {
    this.#streaming = true;
    this.#streamingBuffer += chunk;
    this.#screen.printAboveRaw(dim(this.#streamingBuffer));
  }

  /** Cierra el bloque de streaming. El último displayStream ya fijó el
   * texto en el scrollback; solo limpiamos el buffer interno. */
  endStream(): void {
    if (!this.#streaming) return;
    this.#streaming = false;
    this.#streamingBuffer = "";
  }

  display(text: string): void {
    this.#screen.printAbove(dim(text));
  }
}

class DisplayToolCall implements DisplayText {
  #screen: Screen;
  constructor(screen: Screen) {
    this.#screen = screen;
  }
  display(text: string): void {
    this.#screen.printAbove(cyan(text));
  }
}

class DisplayToolResult implements DisplayText {
  #screen: Screen;
  constructor(screen: Screen) {
    this.#screen = screen;
  }
  display(text: string): void {
    this.#screen.printAbove(gray(text));
  }
}

export { DisplayAssistantText, DisplayToolCall, DisplayToolResult };
