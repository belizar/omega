import { Context } from "../app-context.js";
import { Session } from "../session.js";
import { DisplayAssistantText } from "../tui/components/display-text.js";
import { Command } from "./command.js";
import { SESSIONS_DIR, resumeSession } from "./session-resume.js";

class ResumeCommand implements Command<void> {
  description =
    "Resume una sesión anterior. Sin args abre un selector; o /resume <n|id|nombre> directo.";

  handler(ctx: Context, args: string[]): void {
    const display = new DisplayAssistantText(ctx.screen);
    const sessions = Session.listSessions(SESSIONS_DIR);

    if (sessions.length === 0) {
      display.display("No hay sesiones guardadas.");
      return;
    }

    // El /resume "pelado" lo intercepta el Prompt (selector modal).
    // Acá solo llega la forma directa con argumento.
    if (args.length === 0) {
      display.display(
        "Usá /resume y elegí de la lista, o /resume <n|id|nombre>.",
      );
      return;
    }

    const arg = args[0];
    let sessionId: string | undefined;

    const index = parseInt(arg, 10);
    if (!isNaN(index) && index >= 1 && index <= sessions.length) {
      sessionId = sessions[index - 1].id;
    } else {
      const matchById = sessions.find((s) => s.id.startsWith(arg));
      const matchByName = sessions.find(
        (s) => s.name && s.name.toLowerCase().includes(arg.toLowerCase()),
      );
      sessionId = matchById?.id ?? matchByName?.id;
    }

    if (!sessionId) {
      display.display(
        `No se encontró sesión con id/nombre "${arg}". Usá /resume para ver la lista.`,
      );
      return;
    }

    display.display(resumeSession(ctx, sessionId));
  }
}

export { ResumeCommand };
