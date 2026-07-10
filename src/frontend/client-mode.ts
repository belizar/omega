import { basename } from "path";
import { CoreServices } from "../core.js";
import { logger } from "../logger.js";
import { InputComponent } from "../tui/component.js";
import { Key } from "../tui/decodeKey.js";
import {
  DisplayAssistantText,
  DisplayToolCall,
  DisplayToolResult,
  toolBrief,
} from "../tui/components/display-text.js";
import { LineEditor } from "../tui/components/line-editor.js";
import { SelectList } from "../tui/components/select-list.js";
import { Spinner } from "../tui/components/spinner.js";
import { AnsiRenderer } from "../tui/markdown/ansi-renderer.js";
import { Screen } from "../tui/screen.js";
import { disableRawMode, enableRawMode } from "../tui/terminal.js";
import { dim } from "../tui/theme.js";
import { DaemonClient, DaemonEvent } from "./daemon-client.js";
import { SessionInfo } from "./session-manager.js";
import type { FrontendMode } from "./mode.js";

/** Item de la lista: una sesión, "+ nueva", o "salir". */
type ListItem =
  | { kind: "session"; info: SessionInfo }
  | { kind: "new" }
  | { kind: "quit" };

/** Sentinela: el chat devuelve esto cuando pedís volver a la lista (Esc). */
const BACK = "\x00BACK";

/**
 * Editor del chat. Envuelve el LineEditor y maneja dos teclas propias:
 *  - **Esc** → interrumpe el turno en curso (como la TUI normal). Se queda en la
 *    sesión; el spinner promete "esc para cortar", así que Esc corta.
 *  - **Ctrl-O** → vuelve a la lista de sesiones (out).
 */
class ChatInput implements InputComponent<string> {
  #editor: LineEditor;
  #back = false;
  #onInterrupt: () => void;
  constructor(editor: LineEditor, onInterrupt: () => void) {
    this.#editor = editor;
    this.#onInterrupt = onInterrupt;
  }
  handleKey(key: Key): void {
    if (key.type === "escape") {
      this.#onInterrupt(); // Esc corta el turno (no sale de la sesión)
      return;
    }
    if (key.type === "ctrl" && key.key === "o") {
      this.#back = true; // Ctrl-O vuelve a la lista
      return;
    }
    this.#editor.handleKey(key);
  }
  isDone(): boolean {
    return this.#back || this.#editor.isDone();
  }
  getResult(): string {
    return this.#back ? BACK : this.#editor.getResult();
  }
  render(): string {
    return this.#editor.render();
  }
  getCursorPosition() {
    return this.#editor.getCursorPosition();
  }
}

/**
 * Modo cliente: la TUI como ventana del daemon (mission-control en la terminal).
 * NO corre el loop del agente — le habla al daemon (`omega --serve`) por HTTP/SSE,
 * el mismo protocolo que el browser. Muestra la lista de sesiones de todos los
 * proyectos, entrás a una, y chateás; el turno corre en el daemon y se stremea acá.
 * Arrancar/parar sesiones desde la terminal o el browser es lo mismo — un runtime,
 * muchas ventanas.
 */
export class ClientMode implements FrontendMode {
  #port: number;
  #screen: Screen;
  #spinner: Spinner;
  #assistant: DisplayAssistantText;
  #toolCall: DisplayToolCall;
  #toolResult: DisplayToolResult;
  #editor: LineEditor;

  constructor(core: CoreServices, port: number) {
    this.#port = port;
    const pad = core.config.screenPadding;
    this.#screen = new Screen(pad);
    this.#spinner = new Spinner(this.#screen);
    this.#assistant = new DisplayAssistantText(this.#screen, new AnsiRenderer(pad + 2));
    this.#toolCall = new DisplayToolCall(this.#screen);
    this.#toolResult = new DisplayToolResult(this.#screen);
    this.#editor = new LineEditor();
  }

  async run(): Promise<void> {
    const client = new DaemonClient(this.#port);

    process.stderr.write(dim("  conectando al daemon…\n"));
    const up = await client.ensureUp();
    if (!up) {
      process.stderr.write("  ✗ no se pudo levantar el daemon (omega --serve)\n");
      process.exit(1);
    }

    enableRawMode();
    this.#screen.start();
    try {
      for (;;) {
        const picked = await this.#pickSession(client);
        if (picked.kind === "quit") break;
        if (picked.kind === "new") {
          await this.#newSession(client);
          continue;
        }
        const quit = await this.#chat(client, picked.info);
        if (quit) break;
      }
    } finally {
      disableRawMode();
      logger.info("client mode salió");
      process.exit(0);
    }
  }

  /** readLine para vistas de LISTA: oculta el cursor de texto (la lista navega
   *  con ❯, no tipeás), así no queda un bloque suelto al pie. Lo restaura al salir. */
  async #pickFrom<T>(component: InputComponent<T>): Promise<T> {
    process.stdout.write("\x1b[?25l");
    try {
      return await this.#screen.readLine(component);
    } finally {
      process.stdout.write("\x1b[?25h");
    }
  }

  // ── Lista de sesiones ─────────────────────────────────────────────

  /** Orden ESTABLE: por proyecto, después por id. No depende del estado, así al
   *  refrescar (una sesión pasa de corriendo→idle) las filas NO saltan. */
  #buildItems(sessions: SessionInfo[]): ListItem[] {
    const sorted = [...sessions].sort((a, b) => {
      if (a.project !== b.project) return a.project < b.project ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    return [
      ...sorted.map((info) => ({ kind: "session" as const, info })),
      { kind: "new" as const },
      { kind: "quit" as const },
    ];
  }

  async #pickSession(client: DaemonClient): Promise<ListItem> {
    const first = await client.sessions();
    const list = new SelectList<ListItem>(this.#buildItems(first.sessions), (item, _i, sel) => {
      const arrow = sel ? "❯ " : "  ";
      if (item.kind === "new") return arrow + "+ nueva sesión";
      if (item.kind === "quit") return arrow + "salir";
      const s = item.info;
      const glyph = !s.live ? "⦿" : s.status === "running" ? "●" : s.status === "waiting" ? "◍" : "○";
      const st = !s.live
        ? "dormida"
        : s.status === "running"
          ? "corriendo…"
          : s.status === "waiting"
            ? "esperás vos"
            : "idle";
      const proj = basename(s.project) || "?";
      const title = s.title || s.id.slice(0, 8);
      return `${arrow}${glyph} ${title}${dim(`   ${proj} · ${st}`)}`;
    });

    // Vista full-screen: limpiamos para no apilar scrollback entre navegaciones.
    this.#screen.clearScreen();
    this.#screen.printAbove(dim("\n\n  Ω omega · sesiones   (↑↓ mover · ↵ entrar · esc salir)\n"));

    // Poll: refresca los estados en vivo mientras mirás la lista (así "corriendo…"
    // pasa a "idle" cuando el turno termina, sin salir y volver a entrar).
    const poll = setInterval(async () => {
      try {
        const { sessions } = await client.sessions();
        list.setItems(this.#buildItems(sessions));
        this.#screen.redrawLive();
      } catch {
        /* el daemon puede estar ocupado; reintenta el próximo tick */
      }
    }, 2000);

    try {
      const result = await this.#pickFrom(list);
      if (!result) return { kind: "quit" }; // esc
      return result;
    } finally {
      clearInterval(poll);
    }
  }

  async #newSession(client: DaemonClient): Promise<void> {
    // Elegir el modo con una lista (claro), no un prompt críptico.
    type Mode = { key: "shared" | "attach" | "create"; label: string; desc: string };
    const modes: Mode[] = [
      { key: "shared", label: "Compartida", desc: "sobre el cwd del daemon" },
      { key: "attach", label: "Attach", desc: "a un worktree/carpeta que ya existe" },
      { key: "create", label: "Worktree nuevo", desc: "Omega crea una branch aislada" },
    ];
    const list = new SelectList<Mode>(modes, (m, _i, sel) => {
      const arrow = sel ? "❯ " : "  ";
      return `${arrow}${m.label}${dim(`  — ${m.desc}`)}`;
    });
    this.#screen.clearScreen();
    this.#screen.printAbove(dim("\n\n  nueva sesión — elegí el modo   (↵ elegir · esc cancelar)\n"));
    const mode = await this.#pickFrom(list);
    if (!mode) return; // esc → cancela

    let opts: { mode: string; cwd?: string; branch?: string } = { mode: mode.key };
    if (mode.key === "attach") {
      this.#screen.printAbove(dim("\n  ruta del worktree/carpeta a attachear:"));
      const cwd = (await this.#screen.readLine(this.#editor)).trim();
      this.#editor.reset();
      if (!cwd) return;
      opts.cwd = cwd;
    } else if (mode.key === "create") {
      this.#screen.printAbove(dim("\n  nombre de la branch (vacío = omega/<id>):"));
      const branch = (await this.#screen.readLine(this.#editor)).trim();
      this.#editor.reset();
      if (branch) opts.branch = branch;
    }

    const res = await client.create(opts);
    if (res.error) {
      this.#screen.printAbove(`  ✗ ${res.error}`);
      await new Promise((r) => setTimeout(r, 1200));
      return;
    }
    const { sessions } = await client.sessions();
    const info = sessions.find((s) => s.id === res.id);
    if (info) await this.#chat(client, info);
  }

  // ── Chat de una sesión (stremeado del daemon) ─────────────────────

  async #chat(client: DaemonClient, info: SessionInfo): Promise<boolean> {
    // Entrar a una sesión = pantalla limpia (el chat es scrollback desde acá).
    this.#screen.clearScreen();
    this.#screen.printAbove(
      dim(`\n\n  ── ${info.title}${info.branch ? " · " + info.branch : ""} · ${info.cwd}`),
    );
    this.#screen.printAbove(dim("  (esc corta el turno · ctrl-o a la lista · /exit salir)\n"));

    // ¿Hay un turno corriendo? (para que Esc corte SOLO si hay algo que cortar).
    let running = info.status === "running";
    const pending: Array<{ name: string; input: unknown }> = [];
    const onEvent = (ev: DaemonEvent): void => {
      if (ev.type === "turn_start") running = true;
      else if (ev.type === "turn_end") running = false;
      else if (ev.type === "status") running = ev.status === "running";
      this.#renderEvent(ev, pending);
    };

    const unsub = client.events(info.id, onEvent);
    // Dale un momento al daemon para mandar ready + history y que se rendericen
    // ANTES del primer prompt (si no, el historial aparecería tarde o perdido).
    await new Promise((r) => setTimeout(r, 250));

    // Si entrás a una sesión que YA está corriendo, arrancá el spinner al toque
    // (te perdiste el turn_start, y no llega un `status` porque no hubo cambio).
    if (info.status === "running") this.#spinner.start();

    let quit = false;
    try {
      // NO bloqueamos esperando el turno: el input queda vivo mientras el agente
      // trabaja (el stream aparece arriba). Así podés APRETAR ESC EN CUALQUIER
      // MOMENTO para volver a la lista — el turno sigue corriendo en el daemon —
      // y entrar a otra sesión a laburar en paralelo. Es el punto de todo esto.
      for (;;) {
        const input = await this.#screen.readLine(
          new ChatInput(this.#editor, () => {
            if (!running) return; // no hay turno → Esc no hace nada
            // Feedback INSTANTÁNEO al apretar Esc (no esperamos el roundtrip del
            // daemon): cerramos el stream colgado, paramos el spinner, y avisamos.
            running = false;
            this.#assistant.endStream();
            this.#spinner.stop();
            this.#screen.printAbove(dim("\n  ⏹ Interrumpido por el usuario."));
            void client.interrupt(info.id);
          }),
        );
        const typed = input.trim();
        if (typed === BACK || typed === "/back" || typed === "/list") { this.#editor.reset(); break; }
        if (typed === "") { this.#editor.reset(); continue; }
        if (typed === "/exit" || typed === "/quit" || typed === "exit") {
          this.#editor.reset();
          quit = true;
          break;
        }

        // Eco del input.
        const echo = this.#editor.renderEcho();
        this.#editor.reset();
        this.#screen.printAbove(`\n${echo}`);
        this.#screen.printBlankLine();

        await client.input(info.id, input);
        // Volvemos a readLine de una: el turno se renderiza por SSE mientras tanto,
        // y podés irte (esc) o encolar otro mensaje sin esperar a que termine.
      }
    } finally {
      unsub();
      // Parar el spinner: si te vas con un turno corriendo, no debe filtrarse
      // "Pensando…" a la vista de la lista.
      this.#spinner.stop();
      this.#spinner.reset();
    }
    return quit;
  }

  /** Mapea un evento del daemon a los componentes de display — igual que la TUI
   *  in-process mapea los RunnerEvent, pero desde la red. */
  #renderEvent(
    ev: DaemonEvent,
    pending: Array<{ name: string; input: unknown }>,
  ): void {
    switch (ev.type) {
      case "turn_start":
        pending.length = 0;
        this.#spinner.reset();
        this.#spinner.start();
        break;
      case "delta":
        this.#spinner.stop();
        this.#assistant.displayStream(String(ev.text ?? ""));
        break;
      case "assistant_end":
        this.#assistant.endStream();
        break;
      case "assistant":
        logger.info("client: render assistant", { text: String(ev.text ?? "").slice(0, 40) });
        this.#spinner.stop();
        // Flush de un stream colgado (ej. te uniste a mitad, o se interrumpió sin
        // assistant_end): si no, el mensaje —incluido "⏹ Interrumpido"— no se ve.
        this.#assistant.endStream();
        this.#assistant.display(String(ev.text ?? ""));
        break;
      case "tool_use":
        pending.push({ name: String(ev.name), input: ev.input });
        this.#spinner.setLabel(toolBrief(String(ev.name), ev.input));
        this.#spinner.start();
        break;
      case "tool_result": {
        this.#spinner.stop();
        const call = pending.shift();
        if (call) this.#toolCall.call(call.name, call.input, false);
        this.#toolResult.result(String(ev.output ?? ""), false, undefined, Boolean(ev.isError));
        this.#spinner.setLabel(pending.length > 0 ? toolBrief(pending[0].name, pending[0].input) : null);
        this.#spinner.start();
        break;
      }
      case "turn_end":
        this.#assistant.endStream(); // cerrar cualquier stream colgado
        this.#spinner.stop();
        this.#screen.redrawLive();
        break;
      case "status":
        // Reflejar el estado del turno del daemon aunque te hayas unido a mitad
        // (te perdiste el turn_start): running → mostrás "Pensando" al toque.
        if (ev.status === "running") this.#spinner.start();
        else this.#spinner.stop();
        break;
      case "ask_user":
        this.#spinner.stop();
        this.#screen.printAbove(dim(`\n  ? ${String(ev.question ?? "")}`));
        break;
      case "notify":
        this.#screen.printAbove(dim(String(ev.text ?? "")));
        break;
      case "metrics": {
        const dur = ((Number(ev.durationMs) || 0) / 1000).toFixed(1);
        const cost = Number(ev.turnCost) < 0.01 ? "<$0.01" : `$${Number(ev.turnCost).toFixed(2)}`;
        this.#screen.printAbove(dim(`  ~ ${dur}s · ${ev.toolCalls} tools · ${cost}`));
        break;
      }
      case "history": {
        const items = (ev.items as any[]) ?? [];
        logger.info("client: render history", { count: items.length });
        for (const it of items) {
          if (it.kind === "user") {
            // Mismo estilo prominente (▌ barra + bold) que el echo en vivo, para
            // que tus mensajes se distingan del output del agente también acá.
            this.#screen.printAbove("\n" + this.#editor.renderEchoOf(String(it.text)));
            this.#screen.printBlankLine(); // gap antes de la respuesta del agente
          } else if (it.kind === "assistant") {
            this.#assistant.display(it.text);
          } else if (it.kind === "tool_use") {
            pending.push({ name: it.name, input: it.input });
          } else if (it.kind === "tool_result") {
            const call = pending.shift();
            if (call) this.#toolCall.call(call.name, call.input, false);
            this.#toolResult.result(String(it.output ?? ""), false, undefined, Boolean(it.isError));
          }
        }
        break;
      }
      // ready / status / bye: no aportan al render del chat.
    }
  }
}
