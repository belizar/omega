import { AgentConfig } from "./agent-config.js";
import { Runner } from "./runner.js";
import { Session } from "./session.js";

type ContextConstructorProps = {
  session: Session;
  agentConfig: AgentConfig;
  runner: Runner;
};

class Context {
  #session: Session;
  #agentConfig: AgentConfig;
  #runner: Runner;

  constructor({ session, agentConfig, runner }: ContextConstructorProps) {
    this.#session = session;
    this.#agentConfig = agentConfig;
    this.#runner = runner;
  }

  get session() {
    return this.#session;
  }

  get agentConfig() {
    return this.#agentConfig;
  }

  get runner() {
    return this.#runner;
  }
}

export { Context };
