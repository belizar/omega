import { Context } from "../app-context.js";
import { expandCommand } from "./custom.js";
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

/**
 * Resultado de intentar despachar un input como comando:
 *   - `not-command`: no era un `/comando`; el loop lo trata como mensaje normal.
 *   - `handled`: un built-in ya corrió su efecto (o fue desconocido); no hay turno.
 *   - `expand`: un comando custom se expandió a `text` → el loop corre un turno
 *     con ese texto como mensaje del usuario.
 */
type DispatchOutcome =
  | { kind: "not-command" }
  | { kind: "handled" }
  | { kind: "expand"; text: string };

const dispatchCommand = async (
  cmd: string,
  ctx: Context,
): Promise<DispatchOutcome> => {
  if (!cmd.startsWith("/")) return { kind: "not-command" };

  const [commandName, ...args] = cmd.trim().split(/\s+/);

  // Built-in: tiene precedencia (no se puede pisar /help con un .md).
  const command = commandsMap[commandName];
  if (command) {
    await command.handler(ctx, args);
    return { kind: "handled" };
  }

  // Custom (.omega/commands/*.md): se expande a un prompt y corre como turno.
  const custom = ctx.customCommands[commandName];
  if (custom) {
    return { kind: "expand", text: expandCommand(custom, args) };
  }

  ctx.screen.printAbove(
    `Comando no reconocido: ${commandName}. Usá /help para ver los disponibles.`,
  );
  return { kind: "handled" };
};

export { commandsMap, modalCommandsMap, dispatchCommand, DispatchOutcome };
