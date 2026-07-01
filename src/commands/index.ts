import { Context } from "../app-context.js";
import { ModelCommand } from "./model.js";
import { ProfileCommand } from "./profile.js";
import { SetupCommand } from "./setup.js";
import { AnalyzeCommand } from "./analyze.js";
import { ClearCommand } from "./clear.js";
import { analyzeModalCommand } from "./analyze.js";
import { Command } from "./command.js";
import { ExitCommand } from "./exit.js";
import { HelpCommand } from "./help.js";
import { ModalCommand } from "./modal-command.js";
import { McpCommand } from "./mcp.js";
import { OverridesCommand } from "./overrides.js";
import { RenameCommand } from "./rename.js";
import { ResumeCommand } from "./resume.js";
import { VerboseCommand } from "./verbose.js";
import { StatuslineCommand } from "./statusline.js";
import { CabinetCommand, RememberCommand } from "./cabinet.js";
import { TelemetryCommand } from "./telemetry.js";
import { resumeModalCommand } from "./session-resume.js";

const commandsMap: Record<string, Command<unknown>> = {
  "/analyze": new AnalyzeCommand(),
  "/clear": new ClearCommand(),
  "/exit": new ExitCommand(),
  "/mcp": new McpCommand(),
  "/model": new ModelCommand(),
  "/overrides": new OverridesCommand(),
  "/profile": new ProfileCommand(),
  "/setup": new SetupCommand(),
  "/rename": new RenameCommand(),
  "/resume": new ResumeCommand(),
  "/verbose": new VerboseCommand(),
  "/statusline": new StatuslineCommand(),
  "/cabinet": new CabinetCommand(),
  "/remember": new RememberCommand(),
  "/telemetry": new TelemetryCommand(),
};

commandsMap["/help"] = new HelpCommand(commandsMap);

// Comandos modales: abren un picker que vive en la región del Prompt.
// El "/resume" pelado se resuelve acá; "/resume 3" cae al commandsMap de arriba.
const modalCommandsMap: Record<string, ModalCommand> = {
  "/resume": resumeModalCommand,
  "/analyze": analyzeModalCommand,
};

const dispatchCommand = async (
  cmd: string,
  ctx: Context,
): Promise<boolean> => {
  if (cmd.startsWith("/")) {
    const [commandName, ...args] = cmd.trim().split(/\s+/);
    const command = commandsMap[commandName];
    if (!command) {
      ctx.screen.printAbove(
        `Comando no reconocido: ${commandName}. Usá /help para ver los disponibles.`,
      );
      return true;
    }
    await command.handler(ctx, args);
    return true;
  }

  return false;
};

export { commandsMap, modalCommandsMap, dispatchCommand };
