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
  constructor(screen: Screen) {
    this.#screen = screen;
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
