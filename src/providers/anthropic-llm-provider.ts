import { AgentConfig } from "../agent-config.js";
import { logger } from "../logger.js";
import { Message } from "../message.js";
import { LLMProvider } from "./llm-provider.js";

const TIMEOUT_MS = 60000; // 60 segundos
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

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

  private async callWithRetry(
    messages: Message[],
    agent: AgentConfig,
    attempt: number = 1,
  ): Promise<unknown> {
    const headers = {
      "x-api-key": this.apiKey(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };

    const body = {
      model: agent.model,
      system: agent.systemPrompt,
      max_tokens: agent.maxTokens,
      messages,
      tools: Object.values(agent.tools()).map((t) => t.toJSON()),
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(this.url(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        logger.info("API call successful");
        return data;
      }

      // Handle specific error codes
      if (response.status === 401) {
        const error = `Invalid API key`;
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
    } catch (err: any) {
      if (err.name === "AbortError") {
        logger.error("API request timeout");
        throw new Error(`Request timeout after ${TIMEOUT_MS}ms`);
      }
      throw err;
    }
  }

  async call(messages: Message[], agent: AgentConfig): Promise<unknown> {
    logger.info("Making API call to Anthropic");
    return this.callWithRetry(messages, agent);
  }
}

export { AnthropicProvider };
