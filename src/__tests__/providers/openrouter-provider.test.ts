import { describe, it, expect } from "vitest";
import {
  translateMessages,
  translateTools,
  parseResponse,
} from "../../providers/openrouter-llm-provider.js";
import { AgentFactory } from "../factories/agent.factory.js";
import { Message } from "../../message.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function userText(text: string): Message {
  return { role: "user", content: text };
}

function assistantText(text: string): Message {
  return { role: "assistant", content: text };
}

function assistantWithTools(blocks: Array<{ id: string; name: string; input: unknown }>): Message {
  return {
    role: "assistant",
    content: blocks.map((b) => ({ type: "tool_use" as const, ...b })),
  };
}

function userToolResults(results: Array<{ tool_use_id: string; content: string }>): Message {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result" as const,
      ...r,
      is_error: false,
    })),
  };
}

// ── translateMessages ────────────────────────────────────────────────────────

describe("translateMessages", () => {
  const systemPrompt = "You are a helpful assistant.";

  it("should include system prompt as first message", () => {
    const result = translateMessages([], systemPrompt);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe(systemPrompt);
  });

  it("should translate simple user text messages", () => {
    const result = translateMessages([userText("hello")], systemPrompt);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("user");
    expect(result[1].content).toBe("hello");
  });

  it("should translate simple assistant text messages", () => {
    const result = translateMessages([assistantText("hello back")], systemPrompt);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("hello back");
  });

  it("should translate tool_use blocks in assistant messages", () => {
    const msg = assistantWithTools([
      { id: "t1", name: "read", input: { path: "file.ts" } },
    ]);
    const result = translateMessages([msg], systemPrompt);
    expect(result).toHaveLength(2);
    const assistant = result[1] as { role: "assistant"; content: string | null; tool_calls?: unknown[] };
    expect(assistant.role).toBe("assistant");
    expect(assistant.tool_calls).toHaveLength(1);
    expect((assistant.tool_calls as Record<string, unknown>[])[0].function).toBeDefined();
  });

  it("should translate tool_results as separate tool messages", () => {
    const msg = userToolResults([
      { tool_use_id: "t1", content: "file content" },
    ]);
    const result = translateMessages([msg], systemPrompt);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("tool");
    expect((result[1] as { role: "tool"; tool_call_id: string; content: string }).tool_call_id).toBe("t1");
  });

  it("should translate multiple tool_results to separate tool messages", () => {
    const msg = userToolResults([
      { tool_use_id: "t1", content: "content A" },
      { tool_use_id: "t2", content: "content B" },
    ]);
    const result = translateMessages([msg], systemPrompt);
    expect(result).toHaveLength(3); // system + 2 tool messages
    expect(result[1].role).toBe("tool");
    expect(result[2].role).toBe("tool");
  });

  it("should handle mixed text and tool_use in assistant content", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text" as const, text: "Let me check that file." },
        {
          type: "tool_use" as const,
          id: "abc",
          name: "read",
          input: { path: "x.ts" },
        },
      ],
    };
    const result = translateMessages([msg], systemPrompt);
    expect(result).toHaveLength(2);
    const assistant = result[1] as { role: "assistant"; content: string | null; tool_calls?: unknown[] };
    expect(assistant.content).toBe("Let me check that file.");
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it("should handle user content as array of text blocks", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text" as const, text: "hello" }, { type: "text" as const, text: " world" }],
    };
    const result = translateMessages([msg], systemPrompt);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe("hello world");
  });

  it("should handle user content with image", () => {
    const msg: Message = {
      role: "user",
      content: [
        { type: "text" as const, text: "Look at this:" },
        {
          type: "image" as const,
          source: { type: "base64" as const, media_type: "image/png", data: "abc123" },
        },
      ],
    };
    const result = translateMessages([msg], systemPrompt);
    expect(result).toHaveLength(2);
    const userMsg = result[1] as { role: "user"; content: Array<{ type: string; image_url?: { url: string } }> };
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect(userMsg.content[0].type).toBe("text");
    expect(userMsg.content[1].type).toBe("image_url");
  });

  it("should handle string items in user content array", () => {
    const msg: Message = {
      role: "user",
      content: ["hello", " world"],
    };
    const result = translateMessages([msg], systemPrompt);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe("hello world");
  });

  it("should handle empty message array", () => {
    const result = translateMessages([], systemPrompt);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("system");
  });
});

// ── translateTools ───────────────────────────────────────────────────────────

describe("translateTools", () => {
  it("should translate agent tools to OpenAI format", () => {
    const agent = AgentFactory.createBasicAgent();
    const result = translateTools(agent);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].type).toBe("function");
    expect(result[0].function.name).toBeDefined();
    expect(result[0].function.description).toBeDefined();
    expect(result[0].function.parameters).toBeDefined();
  });

  it("should include all registered tools", () => {
    const agent = AgentFactory.createBasicAgent();
    const toolCount = Object.keys(agent.tools()).length;
    const result = translateTools(agent);
    expect(result).toHaveLength(toolCount);
  });
});

// ── parseResponse ────────────────────────────────────────────────────────────

describe("parseResponse", () => {
  const model = "anthropic/claude-haiku-4-5";

  it("should parse simple text response", () => {
    const data = {
      choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = parseResponse(data, model, null);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { text: string }).text).toBe("Hello!");
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
  });

  it("should parse tool_calls response", () => {
    const data = {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: '{"path":"file.ts"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    };
    const result = parseResponse(data, model, null);
    expect(result.stop_reason).toBe("tool_use");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("tool_use");
    const toolUse = result.content[0] as { type: "tool_use"; id: string; name: string; input: unknown };
    expect(toolUse.name).toBe("read");
    expect(toolUse.input).toEqual({ path: "file.ts" });
  });

  it("should parse max_tokens stop reason", () => {
    const data = {
      choices: [{ message: { content: "Partial..." }, finish_reason: "max_tokens" }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
    const result = parseResponse(data, model, null);
    expect(result.stop_reason).toBe("max_tokens");
  });

  it("should use openrouter cost header when available", () => {
    const data = {
      choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = parseResponse(data, model, "0.0123");
    expect(result.cost).toBe(0.0123);
  });

  it("should estimate cost when no cost header", () => {
    const data = {
      choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    };
    const result = parseResponse(data, model, null);
    expect(result.cost).toBeGreaterThan(0);
  });

  it("should handle malformed tool call arguments", () => {
    const data = {
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "read", arguments: "not valid json!!!" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = parseResponse(data, model, null);
    expect(result.content).toHaveLength(1);
    const toolUse = result.content[0] as { type: "tool_use"; input: unknown };
    expect(toolUse.input).toEqual({});
  });

  it("should handle array content in message", () => {
    const data = {
      choices: [{
        message: {
          content: [
            { type: "text", text: "Hello" },
            { type: "text", text: " World" },
          ],
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const result = parseResponse(data, model, null);
    expect(result.content).toHaveLength(2);
    expect(result.content[0].type).toBe("text");
    expect(result.content[1].type).toBe("text");
  });
});