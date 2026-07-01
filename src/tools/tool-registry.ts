import { Tool } from "./tool.js";
import { Logger } from "../logger.js";
import { McpClient } from "../mcp/client.js";
import { McpServerConfig } from "../mcp/types.js";
import { McpToolWrapper } from "../mcp/tool-wrapper.js";
import { rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export type ToolDescriptor = {
  name: string;
  description: string;
  source: "local" | "cached" | "mcp";
  serverName?: string;
};

/**
 * Registro central de tools. Soporta:
 * - Tools locales (siempre en contexto, ej: read, bash).
 * - Tools cacheadas (descubiertas en esta sesión vía tool_search + register).
 * - Tools MCP (descubrimiento lazy vía McpClient).
 */
export class ToolRegistry {
  #tools: Map<string, Tool<unknown, unknown>> = new Map();
  #localToolNames: Set<string> = new Set();
  #mcpClients: Map<string, McpClient> = new Map();
  #logger: Logger;

  constructor(logger?: Logger) {
    this.#logger = logger ?? (console as unknown as Logger);
  }

  /** Configura servidores MCP (desde .omega/mcp.json). No conecta aún (lazy). */
  configureMcp(servers: Record<string, McpServerConfig> | null): this {
    if (!servers) return this;

    for (const [name, config] of Object.entries(servers)) {
      if (!this.#mcpClients.has(name)) {
        this.#mcpClients.set(name, new McpClient(name, config, this.#logger));
        this.#logger.debug(`MCP server "${name}" registered (lazy)`);
      }
    }
    return this;
  }

  /** Registra una tool local (siempre visible para el LLM). */
  registerLocal(tool: Tool<unknown, unknown>): this {
    this.#tools.set(tool.name, tool);
    this.#localToolNames.add(tool.name);
    return this;
  }

  /** Registra una tool dinámica (descubierta en esta sesión, ej: vía MCP). */
  register(tool: Tool<unknown, unknown>): this {
    this.#tools.set(tool.name, tool);
    return this;
  }

  /** Devuelve una tool por nombre, o undefined. */
  get(name: string): Tool<unknown, unknown> | undefined {
    return this.#tools.get(name);
  }

  /** Tools que van en cada request al LLM. */
  getActiveTools(): Record<string, Tool<unknown, unknown>> {
    return Object.fromEntries(this.#tools);
  }

  /**
   * Busca tools por nombre o descripción.
   * - Tools locales/cacheadas: búsqueda local.
   * - Tools MCP: conecta al servidor si no está conectado, lista tools y cachea
   *   las que matchean. Las no matcheantes también quedan cacheadas pero no se
   *   registran como activas.
   */
  async search(query: string): Promise<ToolDescriptor[]> {
    const q = query.toLowerCase();
    const results: ToolDescriptor[] = [];

    // Buscar en tools locales/cacheadas
    for (const [name, tool] of this.#tools) {
      const json = tool.toJSON();
      const desc = (json.description as string) ?? "";
      if (name.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) {
        results.push({
          name,
          description: desc.length > 120 ? desc.slice(0, 117) + "..." : desc,
          source: this.#localToolNames.has(name) ? "local" : "cached",
        });
      }
    }

    // Buscar en servidores MCP (lazy: conecta bajo demanda)
    for (const [serverName, client] of this.#mcpClients) {
      try {
        await client.connect();
        const mcpTools = await client.listTools();

        // Cachear TODAS las tools del servidor (no solo las que matchean),
        // para que futuras búsquedas y llamadas directas funcionen sin reconectar.
        for (const mcpTool of mcpTools) {
          if (!this.#tools.has(mcpTool.name)) {
            const wrapped = new McpToolWrapper(client, mcpTool);
            this.register(wrapped);
          }
          // Matchear contra el query para los resultados de esta búsqueda
          const desc = mcpTool.description ?? "";
          if (mcpTool.name.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) {
            results.push({
              name: mcpTool.name,
              description: desc.length > 120 ? desc.slice(0, 117) + "..." : desc,
              source: "mcp",
              serverName,
            });
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.#logger.warn(`MCP search failed for "${serverName}": ${msg}`);
        results.push({
          name: `error:${serverName}`,
          description: `Error conectando al servidor MCP "${serverName}": ${msg}`,
          source: "mcp",
          serverName,
        });
      }
    }

    return results;
  }

  /** Devuelve el estado de todos los servidores MCP configurados. */
  getMcpStatus(): Array<{
    name: string;
    commandLine: string;
    status: string;
    lastError: string | null;
    needsAuth: boolean;
  }> {
    const result: Array<{
      name: string;
      commandLine: string;
      status: string;
      lastError: string | null;
      needsAuth: boolean;
    }> = [];

    for (const [name, client] of this.#mcpClients) {
      result.push({
        name,
        commandLine: client.commandLine,
        status: client.status,
        lastError: client.lastError,
        needsAuth: client.needsAuth,
      });
    }

    return result;
  }

  /**
   * Re-autentica un servidor MCP: limpia cache de tokens (~/.mcp-auth),
   * desconecta y reconecta (el server abrirá el browser para OAuth).
   */
  async reauthenticate(serverName: string): Promise<{ ok: boolean; error?: string }> {
    const client = this.#mcpClients.get(serverName);
    if (!client) {
      return { ok: false, error: `Servidor "${serverName}" no configurado en .omega/mcp.json` };
    }

    // Limpiar cache de mcp-remote (best-effort)
    try {
      rmSync(join(homedir(), ".mcp-auth"), { recursive: true, force: true });
      this.#logger.info(`MCP auth cache cleared (~/.mcp-auth) for "${serverName}" re-auth`);
    } catch {
      // best-effort
    }

    // Desconectar
    await client.disconnect();

    // Reconectar con timeout (3 min para el flujo OAuth)
    const TIMEOUT_MS = 3 * 60 * 1000;
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout: el flujo de auth tardó más de 3 minutos")), TIMEOUT_MS)
        ),
      ]);
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /** Mata todos los procesos MCP hijos. Síncrono, best-effort: no awaitea. */
  disconnectAll(): void {
    for (const client of this.#mcpClients.values()) {
      try {
        client.disconnect(); // fire-and-forget — kill() es síncrono
      } catch {
        // best-effort
      }
    }
  }

  /** Cierra todas las conexiones MCP (espera a que terminen). */
  async shutdown(): Promise<void> {
    for (const client of this.#mcpClients.values()) {
      await client.disconnect();
    }
  }
}