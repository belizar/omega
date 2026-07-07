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
    const custom = Object.values(ctx.customCommands);

    if (entries.length === 0 && custom.length === 0) {
      ctx.screen.printAbove("No hay comandos disponibles.");
      return;
    }

    const lines = ["Comandos disponibles:", ""];
    for (const [name, cmd] of entries) {
      lines.push(`  ${name.padEnd(12)} ${cmd.description}`);
    }

    if (custom.length > 0) {
      lines.push("", "Comandos custom (.omega/commands):", "");
      for (const cmd of custom) {
        const label = cmd.argumentHint ? `${cmd.name} ${cmd.argumentHint}` : cmd.name;
        lines.push(`  ${label.padEnd(20)} ${cmd.description}`);
      }
    }

    ctx.screen.printAbove(lines.join("\n"));
  }
}

export { HelpCommand };