import { InputComponent } from "../component.js";
import { Key } from "../decodeKey.js";

class LineEditor implements InputComponent<string> {
  #buffer: string;
  #done: boolean;
  #promptStr = "> ";

  constructor() {
    this.#buffer = "";
    this.#done = false;
  }

  handleKey(key: Key): void {
    switch (key.type) {
      case "char":
        if (key.value === "/") {
        }
        this.#buffer += key.value;
        break;
      case "paste":
        this.#buffer += key.text;
        break; // ← te faltaba paste
      case "newline":
        this.#buffer += "\n";
        break; // Shift+Enter
      case "backspace":
        this.#buffer = this.#buffer.slice(0, -1);
        break;
      case "enter":
        this.#buffer += "\n";
        this.#done = true;
        break;
      // ctrl-c / escape NO acá → el driver decide qué hacer
    }
  }

  private commands() {}

  isDone(): boolean {
    return this.#done;
  }

  getResult(): string {
    return this.#buffer;
  } // ← buffer puro, sin hacks
  render(): string {
    return this.#promptStr + this.#buffer;
  } // prompt en presentación
}

export { LineEditor };
