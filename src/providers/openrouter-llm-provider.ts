import { AgentConfig } from "../agent-config.js";
import { logger } from "../logger.js";
import { Message, ToolMessage } from "../message.js";
import { LLMProvider } from "./llm-provider.js";

const TIMEOUT_MS = 60000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

// ── Tipos internos OpenAI/OpenRouter ─────────────────────────────────────────

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type OpenAITool = {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
};

// ── Tipo de respuesta que el Runner espera ────────────────────────────────────

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type Block = TextBlock | ToolUseBlock;

type ProviderResponse = {
  content: Block[];
  stop_reason: "end_turn" | "tool_use";
  usage: { input_tokens: number; output_tokens: number };
};

// ── Helpers de traducción ─────────────────────────────────────────────────────

function translateMessages(messages: Message[], systemPrompt: string): OpenAIMessage[] {
  const result: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];

  for (const msg of messages) {
    if (msg.role === "user") {
      // content string simple
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
        continue;
      }

      // content array: puede ser tool_results o texto
      if (Array.isArray(msg.content)) {
        const items = msg.content;

        // Si el primer elemento es tool_result, explotamos en mensajes "tool" separados
        if (items.length > 0 && (items[0] as ToolMessage).type === "tool_result") {
          for (const item of items) {
            const tr = item as ToolMessage;
            result.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
            });
          }
        } else {
          // array de TextMessage — concatenar
          const text = items
            .map((b) => (typeof b === "string" ? b : (b as { text: string }).text ?? ""))
            .join("");
          result.push({ role: "user", content: text });
        }
        continue;
      }

      // TextMessage objeto suelto
      const textContent =
        typeof msg.content === "object" && "text" in (msg.content as object)
          ? (msg.content as { text: string }).text
          : String(msg.content);
      result.push({ role: "user", content: textContent });
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        const toolCalls: OpenAIToolCall[] = [];

        for (const block of msg.content) {
          if (typeof block === "string") {
            textParts.push(block);
          } else if ((block as { type: string }).type === "text") {
            textParts.push((block as TextBlock).text);
          } else if ((block as { type: string }).type === "tool_use") {
            const tb = block as unknown as ToolUseBlock;
            toolCalls.push({
              id: tb.id,
              type: "function",
              function: { name: tb.name, arguments: JSON.stringify(tb.input) },
            });
          }
        }

        const assistantMsg: OpenAIMessage = {
          role: "assistant",
          content: textParts.length > 0 ? textParts.join("") : null,
        };
        if (toolCalls.length > 0) {
          (assistantMsg as { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }).tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      } else {
        // string simple
        const text = typeof msg.content === "string" ? msg.content : String(msg.content);
        result.push({ role: "assistant", content: text });
      }
    }
  }

  return result;
}

function translateTools(agent: AgentConfig): OpenAITool[] {
  return Object.values(agent.tools()).map((t) => {
    const json = t.toJSON();
    return {
      type: "function",
      function: {
        name: json.name,
        description: json.description,
        parameters: json.input_schema,
      },
    };
  });
}

function parseResponse(data: any): ProviderResponse {
  const msg = data.choices[0].message;
  const content: Block[] = [];

  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls as OpenAIToolCall[]) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  const stop_reason: "end_turn" | "tool_use" =
    data.choices[0].finish_reason === "tool_calls" ? "tool_use" : "end_turn";

  const usage = {
    input_tokens: data.usage.prompt_tokens as number,
    output_tokens: data.usage.completion_tokens as number,
  };

  return { content, stop_reason, usage };
}

// ── Provider ──────────────────────────────────────────────────────────────────

class OpenRouterProvider extends LLMProvider {
  constructor(apiKey: string) {
    super({
      apiKey,
      url: "https://openrouter.ai/api/v1/chat/completions",
    });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async callWithRetry(
    messages: Message[],
    agent: AgentConfig,
    attempt: number = 1,
  ): Promise<ProviderResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey()}`,
      "Content-Type": "application/json",
    };

    const body = {
      model: agent.model,
      messages: translateMessages(messages, agent.systemPrompt),
      tools: translateTools(agent),
      max_tokens: agent.maxTokens,
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
        logger.info("OpenRouter API call successful");
        return parseResponse(data);
      }

      if (response.status === 401) {
        const error = "OpenRouter: Invalid API key";
        logger.error(error);
        throw new Error(error);
      }

      if (response.status === 429 || response.status === 529) {
        if (attempt < MAX_RETRIES) {
          const backoffMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
          logger.warn(
            `OpenRouter rate limited. Retrying in ${backoffMs}ms (attempt ${attempt}/${MAX_RETRIES})`,
          );
          await this.sleep(backoffMs);
          return this.callWithRetry(messages, agent, attempt + 1);
        }
      }

      const errorData = await response.json();
      logger.error(`OpenRouter API error (${response.status})`, errorData);
      throw new Error(
        `OpenRouter API error: ${response.status} - ${JSON.stringify(errorData)}`,
      );
    } catch (err: any) {
      if (err.name === "AbortError") {
        logger.error("OpenRouter request timeout");
        throw new Error(`Request timeout after ${TIMEOUT_MS}ms`);
      }
      throw err;
    }
  }

  async call(messages: Message[], agent: AgentConfig): Promise<ProviderResponse> {
    logger.info("Making API call to OpenRouter");
    return this.callWithRetry(messages, agent);
  }
}

export { OpenRouterProvider };
