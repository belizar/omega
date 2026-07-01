import { Context } from "../app-context.js";
import { Command } from "./command.js";
import { addMcpServer, removeMcpServer, listMcpServers, loadMcpConfig } from "../mcp/client.js";
import { green, red, yellow, dim } from "../tui/theme.js";

/**
 * /mcp — administración de servidores MCP.
 *
 * /mcp                    tabla de estado de servers configurados
 * /mcp add <name> <cmd> [args...] [--env KEY=VAL ...]
 * /mcp remove <name>
 * /mcp list               lista servers configurados
 * /mcp reload             recarga config desde .omega/mcp.json
 * /mcp auth <server>      re-autentica (limpia cache y reconecta)
 */
class McpCommand implements Command<void> {
  description = "Administrar servidores MCP";

  async handler(ctx: Context, args: string[]): Promise<void> {
    const sub = args[0];

    switch (sub) {
      case "add":     return this.#handleAdd(ctx, args.slice(1));
      case "remove":  return this.#handleRemove(ctx, args.slice(1));
      case "list":    return this.#handleList(ctx);
      case "reload":  return this.#handleReload(ctx);
      case "auth":    return this.#handleAuth(ctx, args.slice(1));
      case "rm":      return this.#handleRemove(ctx, args.slice(1)); // alias
      case "ls":      return this.#handleList(ctx);                  // alias
      default:        return this.#handleStatus(ctx);
    }
  }

  // ── add ────────────────────────────────────────────────────────────────

  #handleAdd(ctx: Context, args: string[]): void {
    const len = args.length;
    if (len < 2) {
      ctx.screen.printAbove("Uso: /mcp add <nombre> <comando> [args...] [--env KEY=VAL ...]");
      return;
    }

    const name = args[0];
    const command = args[1];

    // Separar args del server de las flags --env
    let i = 2;
    const serverArgs: string[] = [];
    const env: Record<string, string> = {};

    while (i < len) {
      if (args[i] === "--env" && i + 1 < len) {
        const eq = args[i + 1].indexOf("=");
        if (eq !== -1) {
          const key = args[i + 1].slice(0, eq);
          const val = args[i + 1].slice(eq + 1);
          env[key] = val;
        }
        i += 2;
      } else {
        serverArgs.push(args[i]);
        i++;
      }
    }

    addMcpServer(process.cwd(), name, {
      command,
      args: serverArgs.length > 0 ? serverArgs : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
    });

    ctx.screen.printAbove(`✓ Servidor MCP "${name}" agregado.`);
    if (serverArgs.length > 0) ctx.screen.printAbove(`  comando: ${command} ${serverArgs.join(" ")}`);
    else ctx.screen.printAbove(`  comando: ${command}`);
    if (Object.keys(env).length > 0) ctx.screen.printAbove(`  env: ${Object.keys(env).join(", ")}`);
  }

  // ── remove ─────────────────────────────────────────────────────────────

  #handleRemove(ctx: Context, args: string[]): void {
    if (!args[0]) {
      ctx.screen.printAbove("Uso: /mcp remove <nombre>");
      return;
    }

    const removed = removeMcpServer(process.cwd(), args[0]);
    if (removed) {
      ctx.screen.printAbove(`✓ Servidor MCP "${args[0]}" eliminado.`);
    } else {
      ctx.screen.printAbove(`✗ Servidor "${args[0]}" no encontrado.`);
    }
  }

  // ── list ───────────────────────────────────────────────────────────────

  #handleList(ctx: Context): void {
    const servers = listMcpServers(process.cwd());
    if (servers.length === 0) {
      ctx.screen.printAbove("No hay servidores MCP configurados (.omega/mcp.json).");
      ctx.screen.printAbove("Usá /mcp add <nombre> <comando> para agregar uno.");
      return;
    }

    const lines: string[] = [];
    for (const s of servers) {
      const args = s.config.args?.join(" ") ?? "";
      lines.push(`  ${s.name}  ${s.config.command} ${args}`);
      if (s.config.env) {
        lines.push(`    env: ${Object.keys(s.config.env).join(", ")}`);
      }
    }
    ctx.screen.printAbove(lines.join("\n"));
  }

  // ── auth ───────────────────────────────────────────────────────────────

  async #handleAuth(ctx: Context, args: string[]): Promise<void> {
    const serverName = args[0];
    if (!serverName) {
      ctx.screen.printAbove("Uso: /mcp auth <server>");
      return;
    }

    ctx.screen.printAbove(`Abrí el browser para autenticar "${serverName}"… esperando autorización…`);

    const res = await ctx.toolRegistry.reauthenticate(serverName);

    if (res.ok) {
      ctx.screen.printAbove(`✓ ${serverName} autenticado`);
    } else {
      ctx.screen.printAbove(`✗ Error: ${res.error}`);
    }
  }

  // ── reload ─────────────────────────────────────────────────────────────

  #handleReload(ctx: Context): void {
    const config = loadMcpConfig(".omega");
    if (!config || Object.keys(config).length === 0) {
      ctx.screen.printAbove("No hay servidores en .omega/mcp.json.");
      return;
    }
    ctx.toolRegistry.configureMcp(config);
    ctx.screen.printAbove(`✓ Recargado: ${Object.keys(config).length} servidores desde .omega/mcp.json.`);
    ctx.screen.printAbove("  Las tools se descubren bajo demanda (lazy) cuando el agente use tool_search.");
  }

  // ── status ─────────────────────────────────────────────────────────────

  #handleStatus(ctx: Context): void {
    const loaded = ctx.toolRegistry.getMcpStatus();
    const fromFile = listMcpServers(process.cwd());

    // Merge: mostrar servidores del archivo, marcando los que ya están cargados
    const loadedNames = new Set(loaded.map((s) => s.name));
    const allNames = new Set([...loadedNames, ...fromFile.map((s) => s.name)]);

    if (allNames.size === 0) {
      ctx.screen.printAbove("No hay servidores MCP configurados.");
      ctx.screen.printAbove("Usá /mcp add <nombre> <comando> para agregar uno.");
      return;
    }

    const lines: string[] = [];
    for (const name of allNames) {
      const fileEntry = fromFile.find((s) => s.name === name);
      const loadedEntry = loaded.find((s) => s.name === name);

      if (loadedEntry) {
        const symbol =
          loadedEntry.status === "connected" ? green("●") :
          loadedEntry.status === "error" ? red("⚠") :
          yellow("○"); // idle

        lines.push(`${symbol} ${name}  ${loadedEntry.commandLine}`);

        if (loadedEntry.lastError) {
          const truncated = loadedEntry.lastError.length > 100
            ? loadedEntry.lastError.slice(0, 97) + "..."
            : loadedEntry.lastError;
          lines.push(`     último error: ${truncated}`);
        }

        if (loadedEntry.needsAuth) {
          lines.push(`     → /mcp auth ${name}`);
        }
      } else if (fileEntry) {
        // En el archivo pero no cargado en memoria
        const argsStr = fileEntry.config.args?.join(" ") ?? "";
        lines.push(`${dim("◆")} ${name}  ${dim(`${fileEntry.config.command} ${argsStr}`)}`);
        lines.push(`     ${yellow("no cargado")} — usá ${green("/mcp reload")} para cargarlo`);
      }
    }

    ctx.screen.printAbove(lines.join("\n"));
  }
}

export { McpCommand };