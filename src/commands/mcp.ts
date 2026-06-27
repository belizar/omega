import { Context } from "../app-context.js";
import { Command } from "./command.js";

/**
 * /mcp — visibilidad y re-auth de servidores MCP.
 *
 * Sin args: tabla de estado de todos los servers configurados.
 * /mcp auth <server>: dispara el flujo OAuth limpiando cache y reconectando.
 */
class McpCommand implements Command<void> {
  description = "Estado de servidores MCP y re-autenticación";

  async handler(ctx: Context, args: string[]): Promise<void> {
    if (args[0] === "auth") {
      await this.#handleAuth(ctx, args.slice(1));
    } else {
      this.#handleStatus(ctx);
    }
  }

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

  #handleStatus(ctx: Context): void {
    const servers = ctx.toolRegistry.getMcpStatus();

    if (servers.length === 0) {
      ctx.screen.printAbove("No hay servidores MCP configurados (.omega/mcp.json).");
      return;
    }

    const lines: string[] = [];
    for (const s of servers) {
      const symbol =
        s.status === "connected" ? "●" :
        s.status === "error" ? "⚠" :
        "○"; // idle

      lines.push(`${symbol} ${s.name}  ${s.commandLine}`);

      if (s.lastError) {
        const truncated = s.lastError.length > 100
          ? s.lastError.slice(0, 97) + "..."
          : s.lastError;
        lines.push(`     último error: ${truncated}`);
      }

      if (s.needsAuth) {
        lines.push(`     → /mcp auth ${s.name}`);
      }
    }

    ctx.screen.printAbove(lines.join("\n"));
  }
}

export { McpCommand };