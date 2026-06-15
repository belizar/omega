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
    stdout.write("\n");
    const timer = setInterval(() => {
      const c = colors[i % colors.length];
      const f = frames[i % frames.length];
      stdout.write(`\r${color(`${f} Pensando`, `38;5;${c}`)}`);
      i++;
    }, 100);
    this.#stop = () => {
      clearInterval(timer);
      stdout.clearLine(0);
      stdout.cursorTo(0);
    };
  }
  stop(): void {
    this.#stop();
  }
}

export { Spinner };
