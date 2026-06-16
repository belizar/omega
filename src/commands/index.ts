import { stdout } from "process";
import { Context } from "../app-context.js";
import { ClearCommand } from "./clear.js";
import { Command } from "./command.js";
import { HelpCommand } from "./help.js";
import { RenameCommand } from "./rename.js";
import { ResumeCommand } from "./resume.js";

const commandsMap: Record<string, Command<unknown>> = {
  "/clear": new ClearCommand(),
  "/rename": new RenameCommand(),
  "/resume": new ResumeCommand(),
};

commandsMap["/help"] = new HelpCommand(commandsMap);

const dispatchCommand = async (
  cmd: string,
  ctx: Context,
): Promise<boolean> => {
  if (cmd.startsWith("/")) {
    const [commandName, ...args] = cmd.trim().split(/\s+/);
    const command = commandsMap[commandName];
    if (!command) {
      stdout.write(`Comando no reconocido: ${commandName}. Usá /help para ver los disponibles.\n`);
      return true;
    }
    await command.handler(ctx, args);
    return true;
  }

  return false;
};

export { commandsMap, dispatchCommand };
