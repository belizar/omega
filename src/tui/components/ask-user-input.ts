import { CursorPosition, InputComponent } from "../component.js";
import { Key } from "../decodeKey.js";

/**
 * Input minimal de una línea para responder preguntas del agente (ask_user).
 * Solo acepta Enter para confirmar y Backspace para borrar.
 */
class AskUserInput implements InputComponent<string> {
  #buffer = "";
  #done = false;
  #prompt = "";

  setPrompt(prompt: string): void {
    this.#prompt = prompt;
  }

  handleKey(key: Key): void {
    if (key.type === "enter") {
      this.#done = true;
      return;
    }
    if (key.type === "char") {
      this.#buffer += key.value;
      return;
    }
    if (key.type === "paste") {
      this.#buffer += key.text.replace(/\n/g, " ");
      return;
    }
    if (key.type === "backspace") {
      if (this.#buffer.length > 0) {
        this.#buffer = this.#buffer.slice(0, -1);
      }
      return;
    }
    // Ignorar otras teclas
  }

  isDone(): boolean {
    return this.#done;
  }

  getResult(): string {
    return this.#buffer.trim();
  }

  render(): string {
    return `${this.#prompt} ${this.#buffer}_`;
  }

  getCursorPosition(): CursorPosition {
    const col = (this.#prompt + " " + this.#buffer).length;
    return { row: 0, col };
  }
}

export { AskUserInput };