import { Tool } from "./tools/tool.js";

type AgentConfigConstructorProps = {
  systemPrompt: string;
  model: string;
  maxTokens: number;
};

class AgentConfig {
  #systemPrompt: string;
  #model: string;
  #max_tokens: number;
  #tools: Record<string, Tool<unknown, unknown>>;

  constructor({ model, maxTokens, systemPrompt }: AgentConfigConstructorProps) {
    this.#systemPrompt = systemPrompt;
    this.#model = model;
    this.#max_tokens = maxTokens;
    this.#tools = {};
  }

  addTool(tool: Tool<unknown, unknown>): AgentConfig {
    this.#tools = { ...this.#tools, [tool.name]: tool };
    return this;
  }

  getTool(name: string) {
    return this.#tools[name];
  }

  get systemPrompt() {
    return this.#systemPrompt;
  }

  get model() {
    return this.#model;
  }

  get maxTokens() {
    return this.#max_tokens;
  }

  tools() {
    return this.#tools;
  }

  toJSON() {
    return {
      model: this.#model,
      max_tokens: this.#max_tokens,
      tools: Object.values(this.#tools).map((t) => t.toJSON()),
    };
  }
}

export { AgentConfig };
