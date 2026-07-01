/** Configuración de un servidor MCP (archivo .omega/mcp.json). */
export type McpServerConfig = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

/** Archivo .omega/mcp.json completo. */
export type McpConfig = {
  servers: Record<string, McpServerConfig>;
};

/** Descriptor de una tool expuesta por un servidor MCP. */
export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
};