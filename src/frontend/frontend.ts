import { RunnerEvent } from "../runner.js";

/** Imagen pegada por el usuario (Ctrl+V), aún sin procesar por visión. */
export interface PastedImage {
  ext: string;
  data: Buffer;
}

/** Resultado de pedir el próximo input al usuario. */
export type FrontendInput =
  /** El usuario mandó un mensaje para el agente. */
  | { kind: "message"; text: string; pastedImages: PastedImage[] }
  /** El usuario pidió salir. */
  | { kind: "exit" }
  /** El input ya se resolvió internamente (comando slash o modal); el loop
   *  sigue de largo (chequeando si quedó un runner pendiente). */
  | { kind: "none" };

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
  /** Pide el próximo input al usuario (en la TUI: el prompt + editor de línea).
   *  Resuelve comandos slash / modales internamente y devuelve qué hacer. */
  nextInput(): Promise<FrontendInput>;

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
