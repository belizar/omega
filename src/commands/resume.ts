import { stdout } from "process";
import { existsSync } from "fs";
import { Context } from "../app-context.js";
import { Session } from "../session.js";
import { DisplayAssistantText } from "../tui/components/display-text.js";
import { bold, dim, green, cyan } from "../tui/theme.js";
import { Command } from "./command.js";

class ResumeCommand implements Command<void> {
  description = "Resume una sesión anterior. /resume [n|id|nombre]  (ej: /resume 3, /resume abc123, /resume bug)";

  handler(ctx: Context, args: string[]): void {
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

    // Sin argumentos: mostrar lista
    if (args.length === 0) {
      stdout.write(`\n Sesiones disponibles (${dir}):\n\n`);
      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const costStr = s.totalCost < 0.01 ? "<$0.01" : `${s.totalCost.toFixed(2)}`;
        const dateStr = s.savedAt ? new Date(s.savedAt).toLocaleString() : "?";
        const nameStr = s.name ? ` ${cyan(s.name)} ` : " ";
        stdout.write(`  ${green(`[${i + 1}]`)}${nameStr}${bold(s.id.slice(0, 8))}...  ${s.messageCount} msgs  ${costStr}  ${dim(dateStr)}\n`);
      }
      stdout.write(`\n  Usá ${bold("/resume <n>")} o ${bold("/resume <id>")} para retomar una.\n\n`);
      return;
    }

    const arg = args[0];
    let sessionId: string | undefined;

    // Intentar como índice numérico
    const index = parseInt(arg, 10);
    if (!isNaN(index) && index >= 1 && index <= sessions.length) {
      sessionId = sessions[index - 1].id;
    } else {
      // Intentar como ID (búsqueda por prefijo)
      const matchById = sessions.find((s) => s.id.startsWith(arg));
      if (matchById) {
        sessionId = matchById.id;
      } else {
        // Intentar por nombre (case-insensitive, parcial)
        const lowerArg = arg.toLowerCase();
        const matchByName = sessions.find(
          (s) => s.name && s.name.toLowerCase().includes(lowerArg),
        );
        if (matchByName) {
          sessionId = matchByName.id;
        } else {
          display.display(`No se encontró sesión con id/nombre "${arg}". Usá /resume sin args para ver la lista.`);
          return;
        }
      }
    }

    if (!sessionId) {
      display.display("Error inesperado al buscar la sesión.");
      return;
    }

    // Crear nueva sesión con el mismo ID para que cargue del disco
    const resumedSession = new Session({
      id: sessionId,
      dir,
      maxMessages: ctx.session.maxMessages,
    });

    const info = resumedSession.info();
    ctx.setSession(resumedSession);

    const label = info.name ? `${green(info.name)} (${info.id})` : green(info.id);
    display.display(`Sesión ${label} retomada (${info.messageCount} mensajes, ${info.totalCost < 0.01 ? "<$0.01" : "$" + info.totalCost.toFixed(2)}).`);
  }
}

export { ResumeCommand };