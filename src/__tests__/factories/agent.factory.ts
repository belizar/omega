import { AgentConfig } from "../../agent-config.js";
import { BashTool } from "../../tools/bash.js";
import { ReadTool } from "../../tools/read.js";
import { EditTool } from "../../tools/edit.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { WriteTool } from "../../tools/write.js";

export class AgentFactory {
  static createBasicAgent(
    systemPrompt?: string,
    maxTokens?: number,
  ): AgentConfig {
    const registry = new ToolRegistry();

    registry
      .registerLocal(new BashTool())
      .registerLocal(new ReadTool(200))
      .registerLocal(new EditTool())
      .registerLocal(new WriteTool());

    return new AgentConfig({
      systemPrompt:
        systemPrompt ||
        "You are a helpful coding assistant that can read, write and edit files.",
      model: "claude-haiku-4-5-20251001",
      maxTokens: maxTokens || 1024,
      toolRegistry: registry,
    });
  }

  static createTestAgent(overrides?: {
    systemPrompt?: string;
    maxTokens?: number;
  }): AgentConfig {
    return this.createBasicAgent(
      overrides?.systemPrompt || "Test agent system prompt",
      overrides?.maxTokens || 512,
    );
  }
}
