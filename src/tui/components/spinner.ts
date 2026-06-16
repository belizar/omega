import { color } from "../theme.js";
import { Screen } from "../screen.js";

/**
 * Spinner como línea de estado: ya no escribe directo a stdout, sino que le
 * pide al Screen que muestre/limpie una línea de estado justo encima del
 * editor. Así no pelea con la región viva del prompt.
 */
class Spinner {
  #screen: Screen;
  #timer: ReturnType<typeof setInterval> | null;

  constructor(screen: Screen) {
    this.#screen = screen;
    this.#timer = null;
  }

  start(): void {
    if (this.#timer) return; // ya andando

    const colors = ["39", "38", "45", "51", "45", "38"];
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;

    this.#timer = setInterval(() => {
      const c = colors[i % colors.length];
      const f = frames[i % frames.length];
      this.#screen.setStatus(color(`${f} Pensando`, `38;5;${c}`));
      i++;
    }, 100);
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#screen.setStatus(null);
  }
}

export { Spinner };
