import { Context } from "../app-context.js";
import { disableRawMode } from "../tui/terminal.js";
import { Command } from "./command.js";

class ExitCommand implements Command<void> {
  description = "Sale de Omega";

  handler(_ctx: Context, _args: string[]): void {
    disableRawMode();
    process.exit(0);
  }
}

export { ExitCommand };
