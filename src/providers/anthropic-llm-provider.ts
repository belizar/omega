import { AgentConfig } from "../agent-config.js";
import { logger } from "../logger.js";
import { Message } from "../message.js";
import { Block, calculateCost, LLMProvider, LLMResponse, StreamEvent } from "./llm-provider.js";

const TIMEOUT_MS = 60000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

type AnthropicResponse = {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "tool_use";
  usage: { input_tokens: number; output_tokens: number };
};

class AnthropicProvider extends LLMProvider {
  constructor(apiKey: string) {
    super({
      apiKey,
      url: "https://api.anthropic.com/v1/messages",
    });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parseResponse(data: AnthropicResponse, model: string): LLMResponse {
    const content: Block[] = data.content.map((block) => {
      if (block.type === "text") {
        return { type: "text", text: block.text };
      }
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    });

    return {
      content,
      stop_reason: data.stop_reason === "tool_use" ? "tool_use" : data.stop_reason,
      usage: {
        input_tokens: data.usage.input_tokens,
        output_tokens: data.usage.output_tokens,
      },
      cost: calculateCost(model, data.usage.input_tokens, data.usage.output_tokens),
    };
  }

  private async callWithRetry(
    messages: Message[],
    agent: AgentConfig,
    attempt: number = 1,
    userSignal?: AbortSignal,
  ): Promise<LLMResponse> {
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };

    const body: Record<string, unknown> = {
      model: agent.model,
      system: agent.systemPrompt,
      max_tokens: agent.maxTokens,
      messages,
      tools: Object.values(agent.tools()).map((t) => t.toJSON()),
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const onAbort = () => controller.abort();
      userSignal?.addEventListener("abort", onAbort, { once: true });

      let response: Response;
      try {
        response = await fetch(this.url(), {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
        userSignal?.removeEventListener("abort", onAbort);
      }

      if (response.ok) {
        const data = (await response.json()) as AnthropicResponse;
        logger.info("API call successful");
        return this.parseResponse(data, agent.model);
      }

      if (response.status === 401) {
        const error = "Invalid API key";
        logger.error(error);
        throw new Error(error);
      }

      if (response.status === 429 || response.status === 529) {
        if (attempt < MAX_RETRIES) {
          const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          logger.warn(
            `Rate limited. Retrying in ${backoffMs}ms (attempt ${attempt}/${MAX_RETRIES})`,
          );
          await this.sleep(backoffMs);
          return this.callWithRetry(messages, agent, attempt + 1);
        }
      }

      const errorData = await response.json();
      logger.error(`API error (${response.status})`, errorData);
      throw new Error(
        `Anthropic API error: ${response.status} - ${JSON.stringify(errorData)}`,
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        if (userSignal?.aborted) {
          const e = new Error("Aborted by user");
          e.name = "AbortError";
          throw e;
        }
        logger.error("API request timeout");
        throw new Error(`Request timeout after ${TIMEOUT_MS}ms`);
      }
      throw err;
    }
  }

  async call(messages: Message[], agent: AgentConfig, signal?: AbortSignal): Promise<LLMResponse> {
    logger.info("Making API call to Anthropic");
    return this.callWithRetry(messages, agent, 1, signal);
  }

  async *callStream(
    _messages: Message[],
    _agent: AgentConfig,
    _signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    throw new Error("AnthropicProvider does not support streaming yet");
  }
}

export { AnthropicProvider };