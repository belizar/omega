import { stdout } from "process";
import { color } from "../theme.js";

class Spinner {
  #stop: () => void;

  constructor() {
    this.#stop = () => {};
  }

  start(): void {
    const colors = ["39", "38", "45", "51", "45", "38"];
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;

    // Ocultar cursor mientras gira
    stdout.write("\x1b[?25l");

    const timer = setInterval(() => {
      const c = colors[i % colors.length];
      const f = frames[i % frames.length];
      // \r nos posiciona al inicio de línea, sobrescribiendo el frame anterior
      stdout.write(`\r${color(`${f} Pensando`, `38;5;${c}`)}`);
      i++;
    }, 100);

    this.#stop = () => {
      clearInterval(timer);
      // Limpiar la línea del spinner y restaurar cursor
      stdout.write("\r\x1b[K\x1b[?25h");
    };
  }

  stop(): void {
    this.#stop();
  }
}

export { Spinner };