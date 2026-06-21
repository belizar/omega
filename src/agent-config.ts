import { Tool } from "./tools/tool.js";

type AgentConfigConstructorProps = {
  systemPrompt: string;
  model: string;
  maxTokens: number;
};

class AgentConfig {
  #baseSystemPrompt: string;
  #dossierFold: string;
  #projectContext: string;
  #model: string;
  #max_tokens: number;
  #tools: Record<string, Tool<unknown, unknown>>;

  constructor({ model, maxTokens, systemPrompt }: AgentConfigConstructorProps) {
    this.#baseSystemPrompt = systemPrompt;
    this.#dossierFold = "";
    this.#projectContext = "";
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

  /** El system prompt completo: base + project context + dossier fold. */
  get systemPrompt() {
    const parts: string[] = [this.#baseSystemPrompt];
    if (this.#projectContext) {
      parts.push(this.#projectContext);
    }
    if (this.#dossierFold) {
      parts.push(this.#dossierFold);
    }
    return parts.join("\n");
  }

  /** Reemplaza el fold del dossier (llamado por el runner antes de cada turno). */
  set dossierFold(text: string) {
    this.#dossierFold = text;
  }

  /** Setea el contexto de proyecto (AGENT.md). */
  set projectContext(text: string) {
    this.#projectContext = text;
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
