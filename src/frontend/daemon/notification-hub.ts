/**
 * Hub de notificaciones GLOBAL (todas las sesiones → una conexión). Es el
 * equivalente al hub por-sesión del WebFrontend, pero cross-sesión: el cliente
 * abre UNA sola SSE (`/events/all`) y recibe los eventos de atención de cualquier
 * workspace, aunque no lo esté mirando. Así el browser puede notificar cuando un
 * agente en background te necesita.
 *
 * Solo transporta eventos de ATENCIÓN (el agente te preguntó algo / terminó el
 * turno) — no el stream completo del chat, que sigue yendo por `/events` de la
 * sesión activa.
 */
export type NotifSink = (data: string) => void;

/** Un evento de atención: un workspace necesita que lo mires. */
export interface AttentionEvent {
  type: "attention";
  sessionId: string;
  /** ask_user = te hizo una pregunta (needs input) · turn_end = terminó el turno. */
  kind: "ask_user" | "turn_end";
  title: string;
  project: string;
  cwd: string;
  /** La pregunta, si kind === "ask_user". */
  question?: string;
  ts: number;
}

export class NotificationHub {
  #clients = new Set<NotifSink>();

  /** Registra un cliente (su sink SSE). Devuelve la baja. */
  add(sink: NotifSink): () => void {
    this.#clients.add(sink);
    return () => this.#clients.delete(sink);
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Emite un evento de atención a todos los clientes conectados. */
  emit(ev: AttentionEvent): void {
    const line = JSON.stringify(ev);
    for (const sink of this.#clients) {
      try {
        sink(line);
      } catch {
        /* cliente muerto: la baja la hace el server al cerrarse la conexión */
      }
    }
  }
}
