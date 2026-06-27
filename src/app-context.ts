import { AgentConfig } from "./agent-config.js";
import { CommandClassifier } from "./classifier/classifier.js";
import { Runner } from "./runner.js";
import { Session } from "./session.js";
import { Screen } from "./tui/screen.js";
import { ToolRegistry } from "./tools/tool-registry.js";

type ContextConstructorProps = {
  session: Session;
  agentConfig: AgentConfig;
  runner: Runner;
  screen: Screen;
  toolRegistry: ToolRegistry;
  classifier?: CommandClassifier;
};

class Context {
  #session: Session;
  #agentConfig: AgentConfig;
  #runner: Runner;
  #screen: Screen;
  #toolRegistry: ToolRegistry;
  #classifier?: CommandClassifier;
  #verbose = false;

  constructor({ session, agentConfig, runner, screen, toolRegistry, classifier }: ContextConstructorProps) {
    this.#session = session;
    this.#agentConfig = agentConfig;
    this.#runner = runner;
    this.#screen = screen;
    this.#toolRegistry = toolRegistry;
    this.#classifier = classifier;
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

  get runner() {
    return this.#runner;
  }
}

export { Context };
