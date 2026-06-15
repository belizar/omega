import { stdout } from "process";
import { Command } from "./command.js";
import { Context } from "../app-context.js";

class HelpCommand implements Command<void> {
  description = "Muestra esta ayuda";
  #commandsMap: Record<string, Command<unknown>>;

  constructor(commandsMap: Record<string, Command<unknown>>) {
    this.#commandsMap = commandsMap;
  }

  handler(_ctx: Context, _args: string[]): void {
    const entries = Object.entries(this.#commandsMap);

    if (entries.length === 0) {
      stdout.write("No hay comandos disponibles.\n");
      return;
    }

    stdout.write("\nComandos disponibles:\n\n");
    for (const [name, cmd] of entries) {
      stdout.write(`  ${name.padEnd(12)} ${cmd.description}\n`);
    }
    stdout.write("\n");
  }
}

export { HelpCommand };