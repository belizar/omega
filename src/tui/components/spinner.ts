import { color, dim } from "../theme.js";
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
  /** Qué está haciendo (ej. "bash npm test"). null → "Pensando". */
  #label: string | null = null;
  /** Cuándo arrancó el turno (para el elapsed). Persiste entre stop/start
   *  dentro del turno; se limpia con reset() al empezar el turno siguiente. */
  #startedAt: number | null = null;

  constructor(screen: Screen) {
    this.#screen = screen;
  }

  /** Cambia el texto de actividad. Toma efecto en el próximo frame. */
  setLabel(label: string | null): void {
    this.#label = label;
  }

  /** Reinicia el cronómetro y el label — al empezar un turno nuevo. */
  reset(): void {
    this.#startedAt = null;
    this.#label = null;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.#tickId++;
    if (this.#startedAt === null) this.#startedAt = Date.now();

    const colors = ["39", "38", "45", "51", "45", "38"];
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const myTick = this.#tickId;

    const tick = () => {
      if (this.#tickId !== myTick) return;
      const c = colors[i % colors.length];
      const f = frames[i % frames.length];
      const elapsed = this.#startedAt ? Math.floor((Date.now() - this.#startedAt) / 1000) : 0;
      const what = this.#label ?? "Pensando";
      this.#screen.setStatus(
        color(`${f} ${what}`, `38;5;${c}`) + dim(` · ${elapsed}s · esc para cortar`),
      );
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