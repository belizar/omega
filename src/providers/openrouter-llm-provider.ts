import { AgentConfig } from "../agent-config.js";
import { logger } from "../logger.js";
import { Message, ToolMessage } from "../message.js";
import { Block, calculateCost, LLMProvider, LLMResponse, StreamEvent, TextBlock, ToolUseBlock } from "./llm-provider.js";

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

function parseResponse(
  data: Record<string, unknown>,
  model: string,
  openrouterCostHeader: string | null,
): LLMResponse {
  const choice = (data.choices as Record<string, unknown>[])[0];
  const msg = choice.message as Record<string, unknown>;
  const content: Block[] = [];

  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  }

  const toolCalls = msg.tool_calls as OpenAIToolCall[] | undefined;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      let input: unknown;
      try {
        // Si arguments ya es un objeto (puede pasar según el provider), usarlo directo
        input = typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments;
      } catch {
        logger.warn("Malformed tool call arguments from LLM, using empty object", {
          tool: tc.function.name,
          arguments: tc.function.arguments,
        });
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const finishReason = choice.finish_reason as string;
  const stop_reason: LLMResponse["stop_reason"] =
    finishReason === "tool_calls" ? "tool_use" : finishReason === "max_tokens" ? "max_tokens" : "end_turn";

  const usageData = data.usage as Record<string, number>;

  // OpenRouter devuelve el costo real en headers; si está disponible lo usamos,
  // si no, estimamos con nuestra tabla de precios.
  let cost: number;
  if (openrouterCostHeader !== null) {
    cost = parseFloat(openrouterCostHeader);
  } else {
    cost = calculateCost(model, usageData.prompt_tokens, usageData.completion_tokens);
  }

  return {
    content,
    stop_reason,
    usage: {
      input_tokens: usageData.prompt_tokens,
      output_tokens: usageData.completion_tokens,
    },
    cost,
  };
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
  ): Promise<LLMResponse> {
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
        const costHeader = response.headers.get("x-openrouter-cost");
        logger.info("OpenRouter API call successful", { cost: costHeader });
        return parseResponse(data, agent.model, costHeader);
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
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        logger.error("OpenRouter request timeout");
        throw new Error(`Request timeout after ${TIMEOUT_MS}ms`);
      }
      throw err;
    }
  }

  async call(messages: Message[], agent: AgentConfig): Promise<LLMResponse> {
    logger.info("Making API call to OpenRouter");
    return this.callWithRetry(messages, agent);
  }

  async *callStream(
    messages: Message[],
    agent: AgentConfig,
  ): AsyncGenerator<StreamEvent> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey()}`,
      "Content-Type": "application/json",
    };

    const body = {
      model: agent.model,
      messages: translateMessages(messages, agent.systemPrompt),
      tools: translateTools(agent),
      max_tokens: agent.maxTokens,
      stream: true,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS * 2);

    let response: Response;
    try {
      response = await fetch(this.url(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Stream request timeout after ${TIMEOUT_MS * 2}ms`);
      }
      throw err;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `OpenRouter stream error: ${response.status} - ${JSON.stringify(errorData)}`,
      );
    }

    if (!response.body) {
      throw new Error("No response body for stream");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls: Map<
      number,
      { id: string; name: string; args: string }
    > = new Map();
    let finishReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // La última línea puede estar incompleta
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            finishReason = finishReason ?? "stop";
            continue;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }

          // Acumular usage si viene en el chunk
          const usage = parsed.usage as Record<string, number> | undefined;
          if (usage) {
            inputTokens = usage.prompt_tokens ?? inputTokens;
            outputTokens = usage.completion_tokens ?? outputTokens;
          }

          const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
          if (!choices || choices.length === 0) continue;

          const delta = choices[0].delta as Record<string, unknown> | undefined;
          if (!delta) continue;

          const finish = choices[0].finish_reason as string | undefined;
          if (finish) finishReason = finish;

          // Texto
          if (delta.content && typeof delta.content === "string") {
            yield { type: "text", text: delta.content };
          }

          // Tool calls en delta
          const tc = delta.tool_calls as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(tc)) {
            for (const t of tc) {
              const idx = t.index as number;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, {
                  id: (t.id as string) ?? "",
                  name: (t.function as Record<string, string>)?.name ?? "",
                  args: "",
                });
              }
              const entry = toolCalls.get(idx)!;
              if (t.id) entry.id = t.id as string;
              const fn = t.function as Record<string, string> | undefined;
              if (fn?.name) entry.name = fn.name;
              if (fn?.arguments) entry.args += fn.arguments;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Después del stream, emitir tool_use completos
    for (const [, tc] of toolCalls) {
      let input: unknown = {};
      try {
        input = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        logger.warn("Malformed stream tool call arguments", { args: tc.args });
      }
      yield { type: "tool_use", id: tc.id, name: tc.name, input };
    }

    const stopReason: "end_turn" | "tool_use" | "max_tokens" =
      finishReason === "tool_calls"
        ? "tool_use"
        : finishReason === "length"
          ? "max_tokens"
          : "end_turn";

    const cost = calculateCost("", inputTokens, outputTokens);

    yield {
      type: "done",
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      cost,
    };
  }
}

export { OpenRouterProvider };
