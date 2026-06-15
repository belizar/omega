import { AgentConfig } from "../agent-config.js";
import { Message } from "../message.js";

type LLMProviderConstructorProps = {
  apiKey: string;
  url: string;
};

// ── Tipos compartidos entre providers ────────────────────────────────────────

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type Block = TextBlock | ToolUseBlock;

type LLMResponse = {
  content: Block[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  usage: { input_tokens: number; output_tokens: number };
};

// ── Provider abstracto ───────────────────────────────────────────────────────

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

  abstract call(messages: Message[], agent: AgentConfig): Promise<LLMResponse>;
}

export { Block, LLMProvider, LLMResponse, TextBlock, ToolUseBlock };
