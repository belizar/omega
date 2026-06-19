import { describe, it, expect, beforeEach } from "vitest";
import { Runner } from "../runner.js";
import { AgentConfig } from "../agent-config.js";
import { LLMProvider, LLMResponse, StreamEvent } from "../providers/llm-provider.js";
import { BashTool } from "../tools/bash.js";
import { ReadTool } from "../tools/read.js";
import { Message } from "../message.js";

// ── Mock LLM Provider ────────────────────────────────────────────────────────

class MockLLMProvider extends LLMProvider {
  #responses: LLMResponse[];
  #callCount = 0;

  constructor(responses: LLMResponse[]) {
    super({ apiKey: "mock-key", url: "http://mock" });
    this.#responses = responses;
  }

  async call(_messages: Message[], _agent: AgentConfig): Promise<LLMResponse> {
    const resp = this.#responses[this.#callCount % this.#responses.length];
    this.#callCount++;
    return resp;
  }

  async *callStream(_messages: Message[], _agent: AgentConfig): AsyncGenerator<StreamEvent> {
    const resp = this.#responses[this.#callCount % this.#responses.length];
    this.#callCount++;

    for (const block of resp.content) {
      if (block.type === "text") {
        yield { type: "text", text: block.text };
      }
      if (block.type === "tool_use") {
        yield { type: "tool_use", id: block.id, name: block.name, input: block.input };
      }
    }

    yield {
      type: "done",
      stop_reason: resp.stop_reason,
      usage: resp.usage,
      cost: resp.cost,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockAgent(): AgentConfig {
  const agent = new AgentConfig({
    systemPrompt: "Test",
    model: "claude-haiku-4-5-20251001",
    maxTokens: 1024,
  });
  agent.addTool(new BashTool());
  agent.addTool(new ReadTool());
  return agent;
}

function textResponse(text: string): LLMResponse {
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    cost: 0.0001,
  };
}

function toolUseResponse(
  toolCalls: Array<{ id: string; name: string; input: unknown }>,
): LLMResponse {
  return {
    content: toolCalls.map((tc) => ({
      type: "tool_use" as const,
      ...tc,
    })),
    stop_reason: "tool_use",
    usage: { input_tokens: 20, output_tokens: 10 },
    cost: 0.0002,
  };
}

function mixedResponse(
  text: string,
  toolCalls: Array<{ id: string; name: string; input: unknown }>,
): LLMResponse {
  return {
    content: [
      { type: "text" as const, text },
      ...toolCalls.map((tc) => ({ type: "tool_use" as const, ...tc })),
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 30, output_tokens: 15 },
    cost: 0.0003,
  };
}

async function collectEvents(runner: Runner, context: Message[]): Promise<Array<{ type: string; name?: string }>> {
  const events: Array<{ type: string; name?: string }> = [];
  for await (const event of runner.run(context)) {
    events.push({ type: event.type, name: "name" in event ? (event as { name: string }).name : undefined });
  }
  return events;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Runner", () => {
  describe("single text response", () => {
    it("should emit text and state events for a simple text response", async () => {
      const provider = new MockLLMProvider([textResponse("Hello!")]);
      const runner = new Runner({ llmProvider: provider, agentConfig: mockAgent() });
      const context: Message[] = [{ role: "user", content: "Hi" }];

      const events = await collectEvents(runner, context);
      expect(events.some((e) => e.type === "text_stream")).toBe(true);
      expect(events.some((e) => e.type === "text_stream_end")).toBe(true);
      expect(events.some((e) => e.type === "state")).toBe(true);
    });

    it("should not emit tool_use events for text-only response", async () => {
      const provider = new MockLLMProvider([textResponse("Done")]);
      const runner = new Runner({ llmProvider: provider, agentConfig: mockAgent() });
      const context: Message[] = [{ role: "user", content: "x" }];

      const events = await collectEvents(runner, context);
      expect(events.some((e) => e.type === "tool_use")).toBe(false);
      expect(events.some((e) => e.type === "tool_result")).toBe(false);
    });
  });

  describe("tool use response", () => {
    it("should execute tool and emit tool_result", async () => {
      // 1st: tool_use, 2nd: end_turn
      const provider = new MockLLMProvider([
        toolUseResponse([{ id: "t1", name: "bash", input: { command: "echo hello" } }]),
        textResponse("Tool executed."),
      ]);
      const runner = new Runner({ llmProvider: provider, agentConfig: mockAgent() });
      const context: Message[] = [{ role: "user", content: "run echo" }];

      const events = await collectEvents(runner, context);
      expect(events.some((e) => e.type === "tool_use")).toBe(true);
      expect(events.some((e) => e.type === "tool_result")).toBe(true);
    });

    it("should handle unknown tool gracefully", async () => {
      const provider = new MockLLMProvider([
        toolUseResponse([{ id: "t1", name: "nonexistent_tool", input: {} }]),
        textResponse("Done"),
      ]);
      const runner = new Runner({ llmProvider: provider, agentConfig: mockAgent() });
      const context: Message[] = [{ role: "user", content: "use unknown tool" }];

      const events = await collectEvents(runner, context);
      expect(events.some((e) => e.type === "tool_result")).toBe(true);
    });

    it("should handle mixed text + tool_use", async () => {
      const provider = new MockLLMProvider([
        mixedResponse("Let me check...", [
          { id: "t1", name: "bash", input: { command: "pwd" } },
        ]),
        textResponse("All done."),
      ]);
      const runner = new Runner({ llmProvider: provider, agentConfig: mockAgent() });
      const context: Message[] = [{ role: "user", content: "where am I?" }];

      const events = await collectEvents(runner, context);
      expect(events.some((e) => e.type === "text_stream")).toBe(true);
      expect(events.some((e) => e.type === "tool_use")).toBe(true);
      expect(events.some((e) => e.type === "tool_result")).toBe(true);
    });
  });

  describe("max_tokens stop reason", () => {
    it("should emit warning text on max_tokens", async () => {
      const provider = new MockLLMProvider([{
        content: [{ type: "text", text: "Partial..." }],
        stop_reason: "max_tokens",
        usage: { input_tokens: 10, output_tokens: 5 },
        cost: 0.0001,
      }]);
      const runner = new Runner({ llmProvider: provider, agentConfig: mockAgent() });
      const context: Message[] = [{ role: "user", content: "big task" }];

      const events: string[] = [];
      for await (const event of runner.run(context)) {
        if (event.type === "text") {
          events.push(event.text);
        }
      }
      const warning = events.find((t) => t.includes("cortó"));
      expect(warning).toBeDefined();
    });
  });

  describe("stop_reason tool_use without tools", () => {
    it("should break the loop when stop_reason is tool_use but no tool blocks exist", async () => {
      // Caso borde: el provider devuelve stop_reason="tool_use" pero sin
      // tool_use blocks en el contenido (respuesta de texto puro). El runner
      // debe frenar, no loopear hasta maxSteps.
      const provider = new MockLLMProvider([{
        content: [{ type: "text", text: "Acá va la respuesta final." }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
        cost: 0.0001,
      }]);
      const runner = new Runner({
        llmProvider: provider,
        agentConfig: mockAgent(),
        maxSteps: 10,
      });
      const context: Message[] = [{ role: "user", content: "algo" }];

      let textEventCount = 0;
      for await (const event of runner.run(context)) {
        if (event.type === "text_stream" || event.type === "text") {
          textEventCount++;
        }
      }

      // Una sola respuesta, el loop debería frenar.
      expect(textEventCount).toBeLessThanOrEqual(2); // text_stream + text_stream_end
    });
  });

  describe("metrics", () => {
    it("should accumulate token usage and cost", async () => {
      const provider = new MockLLMProvider([
        textResponse("First"),
        textResponse("Second"),
      ]);
      const runner = new Runner({ llmProvider: provider, agentConfig: mockAgent() });
      const context: Message[] = [{ role: "user", content: "multi" }];

      for await (const _event of runner.run(context)) {
        // consume
      }

      const metrics = runner.getMetrics();
      expect(metrics.totalInputTokens).toBeGreaterThan(0);
      expect(metrics.totalOutputTokens).toBeGreaterThan(0);
      expect(metrics.totalCost).toBeGreaterThan(0);
      expect(metrics.totalToolCalls).toBe(0);
      expect(metrics.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should count tool calls", async () => {
      const provider = new MockLLMProvider([
        toolUseResponse([{ id: "t1", name: "bash", input: { command: "echo a" } }]),
        textResponse("Done"),
      ]);
      const runner = new Runner({ llmProvider: provider, agentConfig: mockAgent() });
      const context: Message[] = [{ role: "user", content: "run cmd" }];

      for await (const _event of runner.run(context)) {
        // consume
      }

      expect(runner.getMetrics().totalToolCalls).toBe(1);
    });
  });

  describe("max steps", () => {
    it("should stop after maxSteps", async () => {
      // Cada respuesta pide tool_use -> el loop consumiría steps hasta el límite
      const responses: LLMResponse[] = [];
      for (let i = 0; i < 20; i++) {
        responses.push(
          toolUseResponse([{ id: `t${i}`, name: "bash", input: { command: "echo x" } }]),
        );
      }
      const provider = new MockLLMProvider(responses);
      const runner = new Runner({
        llmProvider: provider,
        agentConfig: mockAgent(),
        maxSteps: 3,
      });
      const context: Message[] = [{ role: "user", content: "loop" }];

      let toolUseCount = 0;
      for await (const event of runner.run(context)) {
        if (event.type === "tool_use") toolUseCount++;
      }

      // Con maxSteps=3, el loop hace 3 iteraciones de tool_use
      expect(toolUseCount).toBeLessThanOrEqual(3);
    });
  });

  describe("resetMetrics", () => {
    it("should reset all metrics to zero", async () => {
      const provider = new MockLLMProvider([textResponse("Hi")]);
      const runner = new Runner({ llmProvider: provider, agentConfig: mockAgent() });
      const context: Message[] = [{ role: "user", content: "x" }];

      for await (const _event of runner.run(context)) {
        // consume
      }

      runner.resetMetrics();
      const metrics = runner.getMetrics();
      expect(metrics.totalInputTokens).toBe(0);
      expect(metrics.totalOutputTokens).toBe(0);
      expect(metrics.totalToolCalls).toBe(0);
      expect(metrics.totalCost).toBe(0);
    });
  });
});