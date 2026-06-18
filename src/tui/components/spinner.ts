import { color } from "../theme.js";
import { Screen } from "../screen.js";

/**
 * Spinner: usa la línea de STATUS del Screen (setStatus), que es su slot
 * propio — distinto del efímero, que usa el streaming del texto del agente.
 * Si compartieran slot se pisarían (dos escritores, un solo lugar).
 * El timer solo actualiza el valor; el Screen decide si redibuja según su lock.
 */
class Spinner {
  #screen: Screen;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #tickId = 0;
  #active = false;

  constructor(screen: Screen) {
    this.#screen = screen;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#tickId++;

    const colors = ["39", "38", "45", "51", "45", "38"];
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const myTick = this.#tickId;

    const tick = () => {
      if (this.#tickId !== myTick) return;
      const c = colors[i % colors.length];
      const f = frames[i % frames.length];
      this.#screen.setStatus(color(`${f} Pensando`, `38;5;${c}`));
      i++;
      this.#timer = setTimeout(tick, 100);
    };

    // Primer frame inmediato
    tick();
  }

  stop(): void {
    if (!this.#active) return; // ya parado: evita redibujos al llamarlo de más
    this.#active = false;
    this.#tickId++; // invalida cualquier timer pendiente
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#screen.setStatus(null);
  }
}

export { Spinner };