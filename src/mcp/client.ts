import { spawn, ChildProcess } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { Logger } from "../logger.js";
import { McpServerConfig, McpToolDescriptor } from "./types.js";

/**
 * Cliente MCP que habla JSON-RPC 2.0 sobre stdio.
 *
 * Ciclo de vida perezoso (lazy):
 * - Se crea con la config del servidor, pero no conecta hasta que se necesita.
 * - .connect() lanza el proceso hijo y hace el handshake initialize.
 * - .listTools() devuelve las tools expuestas.
 * - .callTool() ejecuta una tool y devuelve el resultado.
 * - .disconnect() mata el proceso hijo.
 *
 * Si el proceso muere inesperadamente, se marca como desconectado y
 * los próximos llamados lo reconectan automáticamente.
 */
export class McpClient {
  #config: McpServerConfig;
  #logger: Logger;
  #process: ChildProcess | null = null;
  #nextId = 1;
  #pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }> = new Map();
  #buffer = "";
  #serverName: string;
  #status: "idle" | "connected" | "error" = "idle";
  #lastError: string | null = null;
  #needsAuth = false;

  constructor(serverName: string, config: McpServerConfig, logger: Logger) {
    this.#serverName = serverName;
    this.#config = config;
    this.#logger = logger;
  }

  get serverName(): string {
    return this.#serverName;
  }

  get status(): "idle" | "connected" | "error" {
    return this.#status;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  get needsAuth(): boolean {
    return this.#needsAuth;
  }

  /** Línea de comando que se ejecuta para este server. */
  get commandLine(): string {
    const args = this.#config.args ?? [];
    return [this.#config.command, ...args].join(" ");
  }

  /** Lanza el proceso y hace el handshake initialize + notifications/initialized. */
  async connect(): Promise<void> {
    if (this.#process && !this.#process.killed) return;

    this.#logger.info(`MCP connecting to "${this.#serverName}"`, { command: this.#config.command, args: this.#config.args });

    const env = { ...process.env };
    if (this.#config.env) {
      // Expandir variables de entorno (${VAR}) en los values
      for (const [k, v] of Object.entries(this.#config.env)) {
        env[k] = v.replace(/\$\{(\w+)\}/g, (_, name) => env[name] ?? "");
      }
    }

    const args = this.#config.args ?? [];

    this.#process = spawn(this.#config.command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    this.#nextId = 1;
    this.#buffer = "";
    this.#pendingRequests.clear();

    this.#process.stdout!.on("data", (chunk: Buffer) => this.#onData(chunk.toString()));
    this.#process.stderr!.on("data", (chunk: Buffer) => {
      this.#logger.debug(`MCP "${this.#serverName}" stderr: ${chunk.toString().trim()}`);
    });
    this.#process.on("exit", (code) => {
      this.#logger.info(`MCP "${this.#serverName}" process exited with code ${code}`);
      this.#rejectAll(new Error(`MCP process exited with code ${code}`));
      this.#process = null;
    });
    this.#process.on("error", (err) => {
      this.#logger.error(`MCP "${this.#serverName}" process error: ${err.message}`);
      this.#rejectAll(err);
      this.#process = null;
    });

    // Handshake MCP: initialize request
    try {
      const initResult = await this.#sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "omega", version: "1.0.0" },
      });

      this.#logger.debug(`MCP "${this.#serverName}" initialized`, { result: JSON.stringify(initResult).slice(0, 200) });

      // Enviar notificación initialized
      this.#sendNotification("notifications/initialized", {});

      this.#status = "connected";
      this.#lastError = null;
      this.#needsAuth = false;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#status = "error";
      this.#lastError = msg;
      throw err;
    }
  }

  /** Lista las tools expuestas por el servidor. */
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.#sendRequest("tools/list", {});
    const tools = (result as { tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }).tools ?? [];

    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object", properties: {} },
      serverName: this.#serverName,
    }));
  }

  /** Ejecuta una tool en el servidor. */
  async callTool(name: string, input: unknown): Promise<string> {
    const result = await this.#sendRequest("tools/call", { name, arguments: input });
    const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

    if (r.isError) {
      const text = r.content?.map((c) => c.text ?? JSON.stringify(c)).join("\n") ?? "Unknown error";

      // Detectar errores de auth
      if (/auth_revoked|401|unauthorized|not authenticated|session expired/i.test(text)) {
        this.#status = "error";
        this.#lastError = text;
        this.#needsAuth = true;
      }

      throw new Error(`MCP tool "${name}" error: ${text}`);
    }

    const text = r.content?.map((c) => c.text ?? JSON.stringify(c)).join("\n") ?? JSON.stringify(result);
    return text;
  }

  /** Mata el proceso hijo. */
  async disconnect(): Promise<void> {
    if (this.#process && !this.#process.killed) {
      this.#process.kill();
      this.#process = null;
    }
    this.#status = "idle";
    this.#rejectAll(new Error("MCP client disconnected"));
  }

  // ── JSON-RPC internals ──────────────────────────────────────────────────────

  async #sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.#process || this.#process.killed) {
      throw new Error(`MCP "${this.#serverName}" not connected`);
    }

    const id = this.#nextId++;
    const request = JSON.stringify({ jsonrpc: "2.0", method, params, id });
    this.#logger.debug(`MCP "${this.#serverName}" → ${request.slice(0, 300)}`);

    return new Promise((resolve, reject) => {
      this.#pendingRequests.set(id, { resolve, reject });
      this.#process!.stdin!.write(request + "\n");
    });
  }

  #sendNotification(method: string, params: unknown): void {
    if (!this.#process || this.#process.killed) return;
    const notification = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.#process.stdin!.write(notification + "\n");
  }

  #onData(data: string): void {
    this.#buffer += data;

    // Procesar mensajes completos (separados por newline)
    const lines = this.#buffer.split("\n");
    // El último elemento puede estar incompleto
    this.#buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this.#logger.debug(`MCP "${this.#serverName}" ← ${line.slice(0, 300)}`);

        if (msg.id && this.#pendingRequests.has(msg.id)) {
          const { resolve, reject } = this.#pendingRequests.get(msg.id)!;
          this.#pendingRequests.delete(msg.id);

          if (msg.error) {
            reject(new Error(`MCP error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
          } else {
            resolve(msg.result);
          }
        }
        // Notificaciones del servidor: ignoramos por ahora
      } catch {
        this.#logger.warn(`MCP "${this.#serverName}" unparseable line: ${line.slice(0, 200)}`);
      }
    }
  }

  #rejectAll(err: Error): void {
    for (const [, { reject }] of this.#pendingRequests) {
      reject(err);
    }
    this.#pendingRequests.clear();
  }
}

/** Carga la config MCP desde .omega/mcp.json. Devuelve null si no existe. */
export function loadMcpConfig(root: string): Record<string, McpServerConfig> | null {
  try {
    const raw = readFileSync(path.join(root, "mcp.json"), "utf-8");
    const config = JSON.parse(raw);
    return (config.servers as Record<string, McpServerConfig>) ?? null;
  } catch {
    return null;
  }
}

/** Guarda la config MCP en .omega/mcp.json. */
export function saveMcpConfig(root: string, servers: Record<string, McpServerConfig>): void {
  const dir = path.join(root, ".omega");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "mcp.json"), JSON.stringify({ servers }, null, 2) + "\n", "utf-8");
}

/** Agrega (o reemplaza) un servidor MCP en .omega/mcp.json. */
export function addMcpServer(root: string, name: string, config: McpServerConfig): void {
  const existing = loadMcpConfig(path.join(root, ".omega")) ?? {};
  existing[name] = config;
  saveMcpConfig(root, existing);
}

/** Elimina un servidor MCP de .omega/mcp.json. */
export function removeMcpServer(root: string, name: string): boolean {
  const existing = loadMcpConfig(path.join(root, ".omega"));
  if (!existing || !existing[name]) return false;
  delete existing[name];
  saveMcpConfig(root, existing);
  return true;
}

/** Lista los servidores MCP configurados. */
export function listMcpServers(root: string): Array<{ name: string; config: McpServerConfig }> {
  const existing = loadMcpConfig(path.join(root, ".omega"));
  if (!existing) return [];
  return Object.entries(existing).map(([name, config]) => ({ name, config }));
}