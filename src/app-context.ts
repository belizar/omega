import { AgentConfig } from "./agent-config.js";
import { Runner } from "./runner.js";
import { Session } from "./session.js";
import { Screen } from "./tui/screen.js";

type ContextConstructorProps = {
  session: Session;
  agentConfig: AgentConfig;
  runner: Runner;
  screen: Screen;
};

class Context {
  #session: Session;
  #agentConfig: AgentConfig;
  #runner: Runner;
  #screen: Screen;

  constructor({ session, agentConfig, runner, screen }: ContextConstructorProps) {
    this.#session = session;
    this.#agentConfig = agentConfig;
    this.#runner = runner;
    this.#screen = screen;
  }

  get session() {
    return this.#session;
  }

  /** Renderer del prompt. Los comandos imprimen su output con
   * ctx.screen.printAbove para no pisar el editor fijo de abajo. */
  get screen() {
    return this.#screen;
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
