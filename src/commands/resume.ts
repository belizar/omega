import { existsSync } from "fs";
import { Context } from "../app-context.js";
import { Session } from "../session.js";
import { DisplayAssistantText } from "../tui/components/display-text.js";
import { SelectList } from "../tui/components/select-list.js";
import { run } from "../tui/render.js";
import { bold, dim, green, cyan } from "../tui/theme.js";
import { Command } from "./command.js";

type SessionInfo = ReturnType<typeof Session.listSessions>[number];

class ResumeCommand implements Command<void> {
  description = "Resume una sesión anterior. /resume [n|id|nombre]  (ej: /resume 3, /resume abc123, /resume bug)";

  async handler(ctx: Context, args: string[]): Promise<void> {
    const display = new DisplayAssistantText();
    const dir = ".omega/sessions";

    if (!existsSync(dir)) {
      display.display("No hay sesiones guardadas.");
      return;
    }

    const sessions = Session.listSessions(dir);

    if (sessions.length === 0) {
      display.display("No hay sesiones guardadas.");
      return;
    }

    // Sin argumentos: mostrar lista interactiva
    if (args.length === 0) {
      const selected = await this.#interactiveSelect(sessions, dir);
      if (!selected) return; // Escape = cancelar

      await this.#resumeSession(ctx, selected.id, dir, display);
      return;
    }

    // Con argumento: búsqueda directa (índice, id o nombre)
    const arg = args[0];
    let sessionId: string | undefined;

    const index = parseInt(arg, 10);
    if (!isNaN(index) && index >= 1 && index <= sessions.length) {
      sessionId = sessions[index - 1].id;
    } else {
      const matchById = sessions.find((s) => s.id.startsWith(arg));
      if (matchById) {
        sessionId = matchById.id;
      } else {
        const lowerArg = arg.toLowerCase();
        const matchByName = sessions.find(
          (s) => s.name && s.name.toLowerCase().includes(lowerArg),
        );
        if (matchByName) {
          sessionId = matchByName.id;
        } else {
          display.display(
            `No se encontró sesión con id/nombre "${arg}". Usá /resume sin args para ver la lista.`,
          );
          return;
        }
      }
    }

    if (!sessionId) {
      display.display("Error inesperado al buscar la sesión.");
      return;
    }

    await this.#resumeSession(ctx, sessionId, dir, display);
  }

  // ── privados ──────────────────────────────────────────────────────────

  async #interactiveSelect(
    sessions: SessionInfo[],
    _dir: string,
  ): Promise<SessionInfo | null> {
    const list = new SelectList(sessions, (s, i, isSelected) => {
      const prefix = isSelected ? `${green(">")} ` : "  ";
      const num = green(`[${i + 1}]`);
      const name = s.name ? ` ${cyan(s.name)} ` : " ";
      const id = bold(s.id.slice(0, 8));
      const cost = s.totalCost < 0.01 ? "<$0.01" : `$${s.totalCost.toFixed(2)}`;
      const date = s.savedAt ? new Date(s.savedAt).toLocaleString() : "?";
      const msgCount = `${s.messageCount} msgs`;
      return `${prefix}${num}${name}${id}...  ${msgCount}  ${cost}  ${dim(date)}`;
    });

    return run(list);
  }

  async #resumeSession(
    ctx: Context,
    sessionId: string,
    dir: string,
    display: DisplayAssistantText,
  ): Promise<void> {
    try {
      const resumedSession = new Session({
        id: sessionId,
        dir,
        maxContextTokens: ctx.session.maxContextTokens,
      });

      const info = resumedSession.info();
      ctx.setSession(resumedSession);

      const label = info.name
        ? `${green(info.name)} (${info.id})`
        : green(info.id);
      display.display(
        `Sesión ${label} retomada (${info.messageCount} mensajes, ${info.totalCost < 0.01 ? "<$0.01" : "$" + info.totalCost.toFixed(2)}).`,
      );
    } catch {
      display.display(
        `No se pudo cargar la sesión "${sessionId}". El archivo puede estar corrupto.`,
      );
    }
  }
}

export { ResumeCommand };