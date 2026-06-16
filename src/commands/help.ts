import { Command } from "./command.js";
import { Context } from "../app-context.js";

class HelpCommand implements Command<void> {
  description = "Muestra esta ayuda";
  #commandsMap: Record<string, Command<unknown>>;

  constructor(commandsMap: Record<string, Command<unknown>>) {
    this.#commandsMap = commandsMap;
  }

  handler(ctx: Context, _args: string[]): void {
    const entries = Object.entries(this.#commandsMap);

    if (entries.length === 0) {
      ctx.screen.printAbove("No hay comandos disponibles.");
      return;
    }

    const lines = ["Comandos disponibles:", ""];
    for (const [name, cmd] of entries) {
      lines.push(`  ${name.padEnd(12)} ${cmd.description}`);
    }
    ctx.screen.printAbove(lines.join("\n"));
  }
}

export { HelpCommand };