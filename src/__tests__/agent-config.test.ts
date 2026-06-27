import { describe, it, expect, beforeEach } from "vitest";
import { AgentFactory } from "./factories/agent.factory.js";
import { BashTool } from "../tools/bash.js";
import { ReadTool } from "../tools/read.js";

describe("AgentConfig", () => {
  it("should create an agent with system prompt and model", () => {
    const agent = AgentFactory.createBasicAgent(
      "Test system prompt",
      2048,
    );
    expect(agent.systemPrompt).toBe("Test system prompt");
    expect(agent.maxTokens).toBe(2048);
    expect(agent.model).toBe("claude-haiku-4-5-20251001");
  });

  it("should add tools to agent", () => {
    const agent = AgentFactory.createBasicAgent();
    const toolsObj = agent.tools();
    expect(Object.keys(toolsObj).length).toBeGreaterThan(0);
  });

  it("should retrieve tool by name", () => {
    const agent = AgentFactory.createBasicAgent();
    const bashTool = agent.getTool("bash");
    expect(bashTool).toBeDefined();
    expect(bashTool!.name).toBe("bash");
  });

  it("should convert to JSON for API", () => {
    const agent = AgentFactory.createBasicAgent();
    const json = agent.toJSON();
    expect(json.model).toBeDefined();
    expect(json.max_tokens).toBeDefined();
    expect(json.tools).toBeDefined();
    expect(Array.isArray(json.tools)).toBe(true);
  });

  it("should chain add tool calls", () => {
    const agent = AgentFactory.createTestAgent();
    const toolsCount = Object.keys(agent.tools()).length;
    expect(toolsCount).toBeGreaterThan(0);
  });
});
