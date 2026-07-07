import { Tool } from "./tools/tool.js";
import { ToolRegistry } from "./tools/tool-registry.js";

type AgentConfigConstructorProps = {
  systemPrompt: string;
  model: string;
  maxTokens: number;
  toolRegistry: ToolRegistry;
  /** Temperatura de sampling. undefined = no se manda (default del proveedor). */
  temperature?: number;
};

class AgentConfig {
  #systemPrompt: string;
  #model: string;
  #max_tokens: number;
  #registry: ToolRegistry;
  #temperature?: number;

  constructor({ model, maxTokens, systemPrompt, toolRegistry, temperature }: AgentConfigConstructorProps) {
    this.#systemPrompt = systemPrompt;
    this.#model = model;
    this.#max_tokens = maxTokens;
    this.#registry = toolRegistry;
    this.#temperature = temperature;
  }

  /** Agrega una tool local (siempre visible para el LLM). */
  addTool(tool: Tool<unknown, unknown>): AgentConfig {
    this.#registry.registerLocal(tool);
    return this;
  }

  getTool(name: string) {
    return this.#registry.get(name);
  }

  get systemPrompt() {
    return this.#systemPrompt;
  }

  get model() {
    return this.#model;
  }

  setModel(model: string): void {
    this.#model = model;
  }

  get maxTokens() {
    return this.#max_tokens;
  }

  get temperature() {
    return this.#temperature;
  }

  setTemperature(temperature: number): void {
    this.#temperature = temperature;
  }

  /** Tools activas para mandar al LLM en cada request. */
  tools() {
    return this.#registry.getActiveTools();
  }

  toJSON() {
    return {
      model: this.#model,
      max_tokens: this.#max_tokens,
      tools: Object.values(this.#registry.getActiveTools()).map((t) => t.toJSON()),
    };
  }
}

export { AgentConfig };
