import { basename } from "path";
import { CoreServices } from "../core.js";
import { logger } from "../logger.js";
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

  // ── Lista de sesiones ─────────────────────────────────────────────

  async #pickSession(client: DaemonClient): Promise<ListItem> {
    const { sessions } = await client.sessions();
    // Agrupar por proyecto (encuentro), vivas antes que dormidas.
    const sorted = [...sessions].sort((a, b) => {
      if (a.project !== b.project) return a.project < b.project ? -1 : 1;
      if (a.live !== b.live) return a.live ? -1 : 1;
      return (b.lastActive ?? 0) - (a.lastActive ?? 0);
    });

    const items: ListItem[] = [
      ...sorted.map((info) => ({ kind: "session" as const, info })),
      { kind: "new" as const },
      { kind: "quit" as const },
    ];

    let lastProj = "";
    const list = new SelectList<ListItem>(items, (item, _i, sel) => {
      const arrow = sel ? "❯ " : "  ";
      if (item.kind === "new") return arrow + "+ nueva sesión";
      if (item.kind === "quit") return arrow + "salir";
      const s = item.info;
      const header =
        s.project !== lastProj ? dim(`  ${basename(s.project) || "?"}\n`) : "";
      lastProj = s.project;
      const glyph = !s.live ? "⦿" : s.status === "running" ? "●" : s.status === "waiting" ? "◍" : "○";
      const st = !s.live
        ? "dormida"
        : s.status === "running"
          ? "corriendo…"
          : s.status === "waiting"
            ? "esperás vos"
            : "idle";
      const meta = dim(` · ${st}${s.branch ? " · " + s.branch : ""}`);
      const title = s.title || s.id.slice(0, 8);
      return `${header}${arrow}${glyph} ${title}${meta}`;
    });

    this.#screen.printAbove(dim("\n  Ω omega · sesiones   (↑↓ mover · ↵ entrar · esc salir)"));
    const result = await this.#screen.readLine(list);
    if (!result) return { kind: "quit" }; // esc
    return result;
  }

  async #newSession(client: DaemonClient): Promise<void> {
    this.#screen.printAbove(dim("  nueva sesión — ruta a attachear (vacío = compartida):"));
    const path = (await this.#screen.readLine(this.#editor)).trim();
    this.#editor.reset();
    const opts = path ? { mode: "attach", cwd: path } : { mode: "shared" };
    const res = await client.create(opts);
    if (res.error) {
      this.#screen.printAbove(`  ✗ ${res.error}`);
      return;
    }
    // Entrar directo a la sesión recién creada.
    const { sessions } = await client.sessions();
    const info = sessions.find((s) => s.id === res.id);
    if (info) await this.#chat(client, info);
  }

  // ── Chat de una sesión (stremeado del daemon) ─────────────────────

  async #chat(client: DaemonClient, info: SessionInfo): Promise<boolean> {
    this.#screen.printAbove(
      dim(`\n  ── ${info.title}${info.branch ? " · " + info.branch : ""} · ${info.cwd}`),
    );
    this.#screen.printAbove(dim("  (/back a la lista · /exit para salir de omega)\n"));

    // ── Estado del turno + settle ──
    let busy = false;
    let needsInput = false;
    let waiters: Array<() => void> = [];
    const wake = (): void => {
      const w = waiters;
      waiters = [];
      w.forEach((r) => r());
    };
    const settle = (): Promise<void> =>
      busy && !needsInput ? new Promise<void>((r) => waiters.push(r)) : Promise.resolve();

    const pending: Array<{ name: string; input: unknown }> = [];
    const onEvent = (ev: DaemonEvent): void => this.#renderEvent(ev, pending, {
      onBusy: () => (busy = true),
      onIdle: () => { busy = false; wake(); },
      onAsk: () => { needsInput = true; wake(); },
    });

    const unsub = client.events(info.id, onEvent);
    let quit = false;
    try {
      for (;;) {
        // Si hay un turno en curso (ej. entraste a una sesión corriendo), esperá.
        while (busy && !needsInput) await settle();

        const input = await this.#screen.readLine(this.#editor);
        needsInput = false;
        const typed = input.trim();
        if (typed === "") { this.#editor.reset(); continue; }
        if (typed === "/back" || typed === "/list") { this.#editor.reset(); break; }
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
        // Renderizamos el turno mientras llega por SSE; settle resuelve en turn_end.
        while (busy && !needsInput) await settle();
      }
    } finally {
      unsub();
    }
    return quit;
  }

  /** Mapea un evento del daemon a los componentes de display — igual que la TUI
   *  in-process mapea los RunnerEvent, pero desde la red. */
  #renderEvent(
    ev: DaemonEvent,
    pending: Array<{ name: string; input: unknown }>,
    hooks: { onBusy: () => void; onIdle: () => void; onAsk: () => void },
  ): void {
    switch (ev.type) {
      case "turn_start":
        hooks.onBusy();
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
        this.#spinner.stop();
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
        this.#spinner.stop();
        this.#screen.redrawLive();
        hooks.onIdle();
        break;
      case "ask_user":
        this.#spinner.stop();
        this.#screen.printAbove(dim(`\n  ? ${String(ev.question ?? "")}`));
        hooks.onAsk();
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
      case "history":
        for (const it of (ev.items as any[]) ?? []) {
          if (it.kind === "user") {
            this.#screen.printAbove(dim(`\n  › ${it.text}`));
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
      // ready / status / bye: no aportan al render del chat.
    }
  }
}
