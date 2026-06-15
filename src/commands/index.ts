import { Context } from "../app-context.js";
import { ClearCommand } from "./clear.js";
import { Command } from "./command.js";
import { HelpCommand } from "./help.js";

const commandsMap: Record<string, Command<unknown>> = {
  "/clear": new ClearCommand(),
};

commandsMap["/help"] = new HelpCommand(commandsMap);

const dispatchCommand = async <Tin>(
  cmd: string,
  ctx: Context,
): Promise<boolean> => {
  if (cmd.startsWith("/")) {
    const command = commandsMap[cmd.trim()];
    if (!command) {
      return false;
    }
    command.handler(ctx);
    return true;
  }

  return false;
};

export { commandsMap, dispatchCommand };
