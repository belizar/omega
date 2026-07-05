import { RunnerEvent } from "../runner.js";

/**
 * Puerto de ENTRADA (driving) de la arquitectura hexagonal.
 *
 * El core (Runner + loop) habla con esta interfaz, no con la terminal. La TUI
 * es una implementación (`TUIFrontend`); headless / GitHub / Slack serían otras.
 * Ningún método asume que hay una terminal del otro lado.
 *
 * Ver `docs/adr/0001-runner-event-stream-seam.md` y
 * `docs/design/frontend-architecture-design.md`.
 */
export interface Frontend {
  /** Arranca un turno del agente (en la TUI: prende el spinner). */
  turnStarted(): void;

  /**
   * Renderiza un evento del Runner. Los eventos de estado (`state`) NO llegan
   * acá: los consume el loop para persistirlos en la sesión (son core, no
   * presentación). `ask_user` tampoco: va por `askUser()`.
   */
  handleEvent(event: RunnerEvent): void;

  /** Termina un turno (en la TUI: apaga el spinner y redibuja). */
  turnEnded(): void;

  /** Pregunta al usuario y espera su respuesta. Generaliza el viejo `onAskUser`. */
  askUser(question: string): Promise<string>;

  /** Mensaje del sistema fuera de un turno (errores, línea de métricas). */
  notify(text: string): void;

  /**
   * Registra el AbortController del turno en curso para que el frontend pueda
   * cancelarlo (en la TUI: Ctrl+C / Esc). Frontends sin interrupción lo ignoran.
   */
  setAbortController(controller: AbortController): void;
  clearAbortController(): void;
}
