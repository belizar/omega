import { RunnerEvent } from "../../runner.js";
import { Frontend, FrontendInput, TurnMetrics } from "./frontend.js";

export type HeadlessFormat = "json" | "text";

interface HeadlessFrontendDeps {
  /** El prompt de la corrida one-shot. */
  prompt: string;
  format: HeadlessFormat;
  /** El modelo primario resuelto (para el evento `start`). */
  model: string;
  /** Id de la sesión (para el evento `start`). */
  sessionId: string;
  /** Escribe una línea a stdout (la "verdad": eventos JSON o la respuesta). */
  out: (s: string) => void;
  /** Escribe a stderr (actividad de tools / diagnósticos en modo texto). */
  err: (s: string) => void;
}

/**
 * Implementación de `Frontend` sin terminal: maneja a Omega desde otro proceso.
 * Primer consumidor no-TUI del stream de eventos del Runner — la prueba de que el
 * core es una librería, no una app de terminal.
 *
 * Diseño:
 *  - **stdout = la verdad.** En `json`, una línea NDJSON por evento; el consumidor
 *    (ej. el harness de benchmark) parsea la línea `result` final. En `text`, la
 *    respuesta del asistente en limpio, para `respuesta=$(omega -p "…")`.
 *  - **stderr = actividad.** Tool calls / diagnósticos en modo texto van acá, así
 *    stdout queda limpio para capturar.
 *  - **Capa anti-corrupción.** El schema que emitimos NO es `RunnerEvent` crudo:
 *    es un contrato estable (`start` / `assistant` / `tool_use` / `tool_result` /
 *    `result`). Refactorizar el evento interno no rompe al consumidor.
 *
 * One-shot: `nextInput()` entrega el prompt una vez y después pide `exit`.
 */
export class HeadlessFrontend implements Frontend {
  #prompt: string;
  #format: HeadlessFormat;
  #model: string;
  #sessionId: string;
  #out: (s: string) => void;
  #err: (s: string) => void;

  #consumed = false; // el prompt one-shot ya se entregó
  #assistantBlocks: string[] = []; // texto del asistente del turno (para `result`)
  #streamBuf = ""; // acumula deltas de streaming hasta text_stream_end
  #hadError = false; // el turno reportó un error → result.ok = false
  #abort: AbortController | null = null;

  constructor(deps: HeadlessFrontendDeps) {
    this.#prompt = deps.prompt;
    this.#format = deps.format;
    this.#model = deps.model;
    this.#sessionId = deps.sessionId;
    this.#out = deps.out;
    this.#err = deps.err;
  }

  /** Aborta el turno en curso, si hay uno. Lo llama el driver ante SIGINT: corta
   *  la llamada al LLM y deja emitir el `result`, en vez de matar el proceso en
   *  seco. Sin turno activo, no hace nada (el driver decide salir). */
  interrupt(): boolean {
    if (this.#abort) {
      this.#abort.abort();
      return true;
    }
    return false;
  }

  /** ¿El último turno terminó con error? Lo consulta el driver para el exit code. */
  get hadError(): boolean {
    return this.#hadError;
  }

  #emit(obj: Record<string, unknown>): void {
    this.#out(JSON.stringify(obj) + "\n");
  }

  start(): void {
    if (this.#format === "json") {
      this.#emit({ type: "start", session: this.#sessionId, model: this.#model });
    }
  }

  stop(): void {
    // Sin recursos que liberar: no tocamos la terminal.
  }

  async nextInput(): Promise<FrontendInput> {
    if (!this.#consumed) {
      this.#consumed = true;
      return { kind: "message", text: this.#prompt, pastedImages: [] };
    }
    return { kind: "exit" };
  }

  turnStarted(): void {
    // Reset del estado acumulado del turno.
    this.#hadError = false;
    this.#assistantBlocks = [];
    this.#streamBuf = "";
  }

  handleEvent(event: RunnerEvent): void {
    switch (event.type) {
      case "text_stream":
        this.#streamBuf += event.text;
        if (this.#format === "text") this.#out(event.text); // stream en vivo
        break;
      case "text_stream_end":
        if (this.#streamBuf) {
          this.#assistantBlocks.push(this.#streamBuf);
          if (this.#format === "json") {
            this.#emit({ type: "assistant", text: this.#streamBuf });
          } else {
            this.#out("\n");
          }
          this.#streamBuf = "";
        }
        break;
      case "text":
        // Texto completo (proveedor sin streaming).
        this.#assistantBlocks.push(event.text);
        if (this.#format === "json") {
          this.#emit({ type: "assistant", text: event.text });
        } else {
          this.#out(event.text + "\n");
        }
        break;
      case "tool_use":
        if (this.#format === "json") {
          this.#emit({ type: "tool_use", name: event.name, input: event.input });
        } else {
          this.#err(`⚙ ${event.name} ${compactInput(event.input)}\n`);
        }
        break;
      case "tool_result":
        if (this.#format === "json") {
          this.#emit({
            type: "tool_result",
            isError: event.isError ?? false,
            output: event.output,
          });
        } else if (event.isError) {
          this.#err(`✗ tool error\n`);
        }
        break;
      // "state" lo consume el loop (persistencia); "ask_user" va por askUser().
    }
  }

  turnEnded(): void {
    // El `result` se emite en reportMetrics (cuando ya hay métricas).
  }

  async askUser(question: string): Promise<string> {
    // Headless no tiene un humano del otro lado. Reportamos la pregunta y
    // devolvemos una negativa para que el agente no cuelgue esperando.
    if (this.#format === "json") {
      this.#emit({ type: "ask_user", question });
    } else {
      this.#err(`? ${question}\n`);
    }
    return "No hay un usuario interactivo disponible (modo headless). Asumí un default razonable o explicá por qué no podés continuar sin confirmación.";
  }

  notify(text: string): void {
    // notify sólo se usa para errores del turno (las métricas van por
    // reportMetrics). Marcamos el turno como fallido para el `result`.
    this.#hadError = true;
    if (this.#format === "json") {
      this.#emit({ type: "error", message: text.trim() });
    } else {
      this.#err(text.trim() + "\n");
    }
  }

  reportMetrics(m: TurnMetrics): void {
    if (this.#format === "json") {
      this.#emit({
        type: "result",
        ok: !this.#hadError,
        model: m.model,
        text: this.#assistantBlocks.join("\n\n"),
        metrics: {
          steps: m.steps,
          contextTokens: m.contextTokens,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          cost: m.turnCost,
          totalCost: m.totalCost,
          toolCalls: m.toolCalls,
          toolErrors: m.toolErrors,
          durationMs: m.durationMs,
          rereads: m.rereads,
        },
      });
    } else {
      const cost = m.turnCost < 0.01 ? "<$0.01" : `$${m.turnCost.toFixed(2)}`;
      this.#err(
        `~ ${m.inputTokens} in · ${m.outputTokens} out · ${m.steps} steps · ${m.toolCalls} tools · ${(m.durationMs / 1000).toFixed(1)}s · ${cost}\n`,
      );
    }
  }

  setAbortController(controller: AbortController): void {
    this.#abort = controller;
  }

  clearAbortController(): void {
    this.#abort = null;
  }
}

/** Resumen de una línea del input de una tool, para el modo texto. */
function compactInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 120 ? s.slice(0, 117) + "…" : s;
  } catch {
    return "";
  }
}
