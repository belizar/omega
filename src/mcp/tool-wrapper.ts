import { Tool } from "../tools/tool.js";
import { McpClient } from "./client.js";
import { McpToolDescriptor } from "./types.js";

/**
 * Wrapper que convierte un descriptor de tool MCP en una Tool de Omega.
 * Delega la ejecución al McpClient correspondiente.
 */
export class McpToolWrapper extends Tool<Record<string, unknown>, string> {
  #client: McpClient;
  #mcpName: string;

  constructor(client: McpClient, descriptor: McpToolDescriptor) {
    super({
      name: descriptor.name,
      description: descriptor.description ?? `MCP tool from ${descriptor.serverName}`,
      schema: descriptor.inputSchema,
    });
    this.#client = client;
    this.#mcpName = descriptor.name;
  }

  async execute(input: Record<string, unknown>): Promise<string> {
    return this.#client.callTool(this.#mcpName, input);
  }
}