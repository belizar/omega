import { AgentConfig } from "../agent-config.js";
import { Message } from "../message.js";

type LLMProviderConstructorProps = {
  apiKey: string;
  url: string;
};

abstract class LLMProvider {
  #apiKey: string;
  #url: string;

  constructor({ apiKey, url }: LLMProviderConstructorProps) {
    this.#apiKey = apiKey;
    this.#url = url;
  }

  protected apiKey() {
    return this.#apiKey;
  }

  protected url() {
    return this.#url;
  }

  abstract call(messages: Message[], agent: AgentConfig): Promise<unknown>;
}

export { LLMProvider };
