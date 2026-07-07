import { AgentConfig } from "./agent-config.js";
import { CommandClassifier } from "./classifier/classifier.js";
import { CustomCommand } from "./commands/custom.js";
import { Session } from "./session.js";
import { Screen } from "./tui/screen.js";
import { ToolRegistry } from "./tools/tool-registry.js";

type ContextConstructorProps = {
  session: Session;
  agentConfig: AgentConfig;
  screen: Screen;
  toolRegistry: ToolRegistry;
  classifier?: CommandClassifier;
  customCommands?: Record<string, CustomCommand>;
};

class Context {
  #session: Session;
  #agentConfig: AgentConfig;
  #screen: Screen;
  #toolRegistry: ToolRegistry;
  #classifier?: CommandClassifier;
  #customCommands: Record<string, CustomCommand>;
  #verbose = false;

  constructor({ session, agentConfig, screen, toolRegistry, classifier, customCommands }: ContextConstructorProps) {
    this.#session = session;
    this.#agentConfig = agentConfig;
    this.#screen = screen;
    this.#toolRegistry = toolRegistry;
    this.#classifier = classifier;
    this.#customCommands = customCommands ?? {};
  }

  get verbose() {
    return this.#verbose;
  }

  toggleVerbose(): boolean {
    this.#verbose = !this.#verbose;
    return this.#verbose;
  }

  get session() {
    return this.#session;
  }

  /** Renderer del prompt. Los comandos imprimen su output con
   * ctx.screen.printAbove para no pisar el editor fijo de abajo. */
  get screen() {
    return this.#screen;
  }

  /** Manager de overrides del clasificador de comandos */
  get classifier() {
    return this.#classifier;
  }

  /** Slash commands definidos por el usuario en .omega/commands/*.md */
  get customCommands() {
    return this.#customCommands;
  }

  get toolRegistry() {
    return this.#toolRegistry;
  }

  /** Reemplaza la sesión activa (ej: al resumir otra sesión) */
  setSession(session: Session): void {
    this.#session = session;
  }

  get agentConfig() {
    return this.#agentConfig;
  }

  /** El nombre del perfil activo. */
  get profile(): string {
    return this.#session.profile;
  }
}

export { Context };
