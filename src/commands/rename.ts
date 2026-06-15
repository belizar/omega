import { Context } from "../app-context.js";
import { DisplayAssistantText } from "../tui/components/display-text.js";
import { green } from "../tui/theme.js";
import { Command } from "./command.js";

class RenameCommand implements Command<void> {
  description = "Renombra la sesión actual. /rename <nombre>";

  handler(ctx: Context, args: string[]): void {
    const display = new DisplayAssistantText();

    if (args.length === 0) {
      const current = ctx.session.name || "(sin nombre)";
      display.display(`Nombre actual: ${green(current)}. Usá /rename <nuevo nombre> para cambiarlo.`);
      return;
    }

    const newName = args.join(" ").trim();
    if (!newName) {
      display.display("El nombre no puede estar vacío.");
      return;
    }

    ctx.session.rename(newName);
    display.display(`Sesión renombrada a ${green(newName)}.`);
  }
}

export { RenameCommand };