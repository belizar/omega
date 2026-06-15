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
  cost: number; // USD
};

// ── Precios OpenRouter por millón de tokens (USD) ────────────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude 4 / 4.5
  "anthropic/claude-haiku-4-5": { input: 0.80, output: 4.00 },
  "anthropic/claude-sonnet-4": { input: 3.00, output: 15.00 },
  "anthropic/claude-opus-4": { input: 15.00, output: 75.00 },
  // Claude 3.5
  "anthropic/claude-3.5-haiku": { input: 0.80, output: 4.00 },
  "anthropic/claude-3.5-sonnet": { input: 3.00, output: 15.00 },
  "anthropic/claude-3-opus": { input: 15.00, output: 75.00 },
};

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    for (const [key, p] of Object.entries(MODEL_PRICING)) {
      // Match exacto de la clave completa
      if (model === key) {
        pricing = p;
        break;
      }
      // Match por prefijo: el modelo empieza con la clave (ej: "anthropic/claude-...")
      if (model.startsWith(key)) {
        pricing = p;
        break;
      }
      // Match sin el prefijo del proveedor: "claude-haiku-4-5" vs "anthropic/claude-haiku-4-5"
      const afterSlash = key.includes("/") ? key.split("/").slice(1).join("/") : key;
      if (model.startsWith(afterSlash)) {
        pricing = p;
        break;
      }
    }
  }
  if (!pricing) return 0; // modelo desconocido, no estimamos

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

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

export { Block, LLMProvider, LLMResponse, TextBlock, ToolUseBlock, calculateCost };
