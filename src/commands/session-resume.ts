import { stdout } from "process";
import { Context } from "../app-context.js";
import { Session } from "../session.js";
import { SelectList } from "../tui/components/select-list.js";
import { bold, cyan, dim, green } from "../tui/theme.js";
import { ModalCommand, ModalOpen } from "./modal-command.js";

const SESSIONS_DIR = ".omega/sessions";

type SessionSummary = ReturnType<typeof Session.listSessions>[number];

/**
 * Carga una sesión por id, la setea como activa en el ctx y devuelve un
 * mensaje de confirmación. Compartido por el comando directo (/resume 3) y
 * el modal (picker).
 */
function resumeSession(ctx: Context, sessionId: string): string {
  let resumed: Session;
  try {
    resumed = new Session({
      id: sessionId,
      dir: SESSIONS_DIR,
      maxContextTokens: ctx.session.maxContextTokens,
    });
  } catch (err: unknown) {
    return `No se pudo cargar la sesión (¿corrupta?): ${err instanceof Error ? err.message : String(err)}`;
  }

  const info = resumed.info();
  ctx.setSession(resumed);

  const label = info.name ? `${green(info.name)} (${info.id})` : green(info.id);
  const cost = info.totalCost < 0.01 ? "<$0.01" : `$${info.totalCost.toFixed(2)}`;
  return `Sesión ${label} retomada (${info.messageCount} mensajes, ${cost}).`;
}

/** Formatea una fila del picker, con marcador del seleccionado. */
function renderSessionRow(
  s: SessionSummary,
  index: number,
  isSelected: boolean,
): string {
  const marker = isSelected ? cyan("❯ ") : "  ";
  const num = green(`[${index + 1}]`);
  const name = s.name ? ` ${cyan(s.name)} ` : " ";
  const id = bold(s.id.slice(0, 8)) + "...";
  const cost = s.totalCost < 0.01 ? "<$0.01" : `$${s.totalCost.toFixed(2)}`;
  const date = s.savedAt ? new Date(s.savedAt).toLocaleString() : "?";
  return `${marker}${num}${name}${id}  ${s.messageCount} msgs  ${cost}  ${dim(date)}`;
}

/** Comando modal /resume: abre un picker de sesiones. */
const resumeModalCommand: ModalCommand = {
  name: "/resume",

  open(_ctx: Context): ModalOpen {
    const sessions = Session.listSessions(SESSIONS_DIR);
    if (sessions.length === 0) {
      return { message: "No hay sesiones guardadas." };
    }
    // Cap la altura del picker para que la región (editor + lista) entre en
    // pantalla. Si la región es más alta que el terminal, scrollea y rompe
    // el save/restore de cursor (\x1b7/\x1b8) que usa run() → fragmentos.
    // Reservamos 7 líneas: caja del editor (3) + margen (4), igual al
    // presupuesto que ya funcionaba en el /resume interactivo viejo.
    const rows = stdout.rows || 24;
    const maxVisible = Math.max(3, Math.min(20, rows - 7));
    return { picker: new SelectList(sessions, renderSessionRow, maxVisible) };
  },

  apply(ctx: Context, value: unknown): string {
    const s = value as SessionSummary;
    return resumeSession(ctx, s.id);
  },
};

export { SESSIONS_DIR, resumeSession, resumeModalCommand };
