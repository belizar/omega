import { Context } from "../app-context.js";
import { DisplayAssistantText } from "../tui/components/display-text.js";
import { Command } from "./command.js";

class ClearCommand implements Command<void> {
  description = "Limpia la conversación actual";

  handler(ctx: Context): void {
    ctx.session.clear();
    new DisplayAssistantText().display("Conversacion limpia");
  }
}

export { ClearCommand };
