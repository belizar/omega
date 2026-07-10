import { RunnerEvent } from "../runner.js";
import { Frontend, FrontendInput, TurnMetrics } from "./frontend.js";

/**
 * Cola async de un solo consumidor: `push` deposita, `next` entrega (o espera).
 * El input del WebFrontend es una sola cola mergeada — el mensaje de CUALQUIER
 * cliente entra acá, y quien esté esperando (el loop en `nextInput`, o un turno
 * en `askUser`) lo recibe. Nunca esperan los dos a la vez, así un solo resolver
 * alcanza.
 */
class InputQueue {
  #items: string[] = [];
  #resolvers: ((v: string) => void)[] = [];

  push(v: string): void {
    const r = this.#resolvers.shift();
    if (r) r(v);
    else this.#items.push(v);
  }

  next(): Promise<string> {
    const v = this.#items.shift();
    if (v !== undefined) return Promise.resolve(v);
    return new Promise((res) => this.#resolvers.push(res));
  }
}

/** Un cliente conectado: una función que le empuja una línea de evento (SSE). */
export type ClientSink = (data: string) => void;

/**
 * Frontend web: implementa el puerto `Frontend` pero, en vez de renderizar, es un
 * HUB por sesión. Es el "headless bidireccional sobre la red":
 *  - **fan-out:** `handleEvent` serializa el evento y lo BROADCASTEA a todos los
 *    clientes conectados (SSE). Uno o mil, da igual — el loop no se entera.
 *  - **fan-in:** `nextInput`/`askUser` drenan de una sola cola; el mensaje de
 *    cualquier cliente (POST /input) entra ahí.
 *
 * El schema que emite es un contrato estable (capa anti-corrupción), no el
 * `RunnerEvent` crudo — así refactorizar el evento interno no rompe al browser.
 */
/** Estado de una sesión, para el sidebar (paridad cmux). */
export type SessionStatus = "idle" | "running" | "waiting";

export class WebFrontend implements Frontend {
  #clients = new Set<ClientSink>();
  #queue = new InputQueue();
  #model: string;
  #sessionId: string;
  #abort: AbortController | null = null;
  #status: SessionStatus = "idle";

  constructor(deps: { model: string; sessionId: string }) {
    this.#model = deps.model;
    this.#sessionId = deps.sessionId;
  }

  /** Estado actual: idle (esperando tarea) / running (turno en curso) / waiting
   *  (el agente te preguntó algo y espera respuesta). Lo lee el SessionManager. */
  get status(): SessionStatus {
    return this.#status;
  }

  #setStatus(s: SessionStatus): void {
    if (this.#status === s) return;
    this.#status = s;
    this.#broadcast({ type: "status", status: s });
  }

  // ── Hub: gestión de clientes e input ──────────────────────────────

  /** Registra un cliente (su sink SSE). Devuelve la baja. Le manda un `ready`
   *  al toque para que sepa contra qué sesión/modelo está. */
  addClient(sink: ClientSink): () => void {
    this.#clients.add(sink);
    sink(this.#frame({ type: "ready", session: this.#sessionId, model: this.#model }));
    return () => this.#clients.delete(sink);
  }

  /** Input de un cliente (POST /input) → a la cola mergeada. */
  submitInput(text: string): void {
    this.#queue.push(text);
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  #frame(obj: Record<string, unknown>): string {
    return JSON.stringify(obj);
  }

  #broadcast(obj: Record<string, unknown>): void {
    const line = this.#frame(obj);
    for (const sink of this.#clients) {
      try {
        sink(line);
      } catch {
        /* cliente muerto: la baja la hace el server al cerrarse la conexión */
      }
    }
  }

  // ── Puerto Frontend ───────────────────────────────────────────────

  start(): void {
    /* El server ya está escuchando; nada que inicializar acá. */
  }

  stop(): void {
    this.#broadcast({ type: "bye" });
    this.#clients.clear();
  }

  async nextInput(): Promise<FrontendInput> {
    const text = await this.#queue.next();
    if (text === "/exit" || text === "exit") return { kind: "exit" };
    return { kind: "message", text, pastedImages: [] };
  }

  turnStarted(): void {
    this.#setStatus("running");
    this.#broadcast({ type: "turn_start" });
  }

  handleEvent(event: RunnerEvent): void {
    switch (event.type) {
      case "text_stream":
        this.#broadcast({ type: "delta", text: event.text });
        break;
      case "text_stream_end":
        this.#broadcast({ type: "assistant_end" });
        break;
      case "text":
        this.#broadcast({ type: "assistant", text: event.text });
        break;
      case "tool_use":
        this.#broadcast({ type: "tool_use", name: event.name, input: event.input });
        break;
      case "tool_result":
        this.#broadcast({
          type: "tool_result",
          isError: event.isError ?? false,
          output: event.output,
        });
        break;
      // "state" lo consume el loop (persistencia); "ask_user" va por askUser().
    }
  }

  turnEnded(): void {
    this.#setStatus("idle");
    this.#broadcast({ type: "turn_end" });
  }

  async askUser(question: string): Promise<string> {
    this.#setStatus("waiting");
    this.#broadcast({ type: "ask_user", question });
    // Misma cola: la próxima línea que mande cualquier cliente es la respuesta.
    const answer = await this.#queue.next();
    this.#setStatus("running"); // el turno sigue tras la respuesta
    return answer;
  }

  notify(text: string): void {
    this.#broadcast({ type: "notify", text: text.trim() });
  }

  reportMetrics(m: TurnMetrics): void {
    this.#broadcast({
      type: "metrics",
      model: m.model,
      steps: m.steps,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      turnCost: m.turnCost,
      totalCost: m.totalCost,
      toolCalls: m.toolCalls,
      durationMs: m.durationMs,
    });
  }

  setAbortController(controller: AbortController): void {
    this.#abort = controller;
  }

  clearAbortController(): void {
    this.#abort = null;
  }

  /** Aborta el turno en curso (para un futuro botón "stop" en el cliente). */
  interrupt(): boolean {
    if (this.#abort) {
      this.#abort.abort();
      return true;
    }
    return false;
  }
}
