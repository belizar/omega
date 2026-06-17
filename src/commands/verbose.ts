import { Context } from "../app-context.js";
import { DisplayAssistantText } from "../tui/components/display-text.js";
import { Command } from "./command.js";

class VerboseCommand implements Command<void> {
  description = "Activa/desactiva el modo verbose para salida de tools";

  handler(ctx: Context, _args: string[]): void {
    const on = ctx.toggleVerbose();
    new DisplayAssistantText(ctx.screen).display(
      `Modo verbose ${on ? "activado" : "desactivado"}.`,
    );
  }
}

export { VerboseCommand };
