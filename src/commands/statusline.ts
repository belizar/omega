import { execSync } from "child_process";
import { Context } from "../app-context.js";
import { Command } from "./command.js";
import { dim, cyan, green } from "../tui/theme.js";

const STATUSLINE_KEY = "statusline";

// Placeholders soportados
const PLACEHOLDERS: Record<string, (ctx?: Context) => string | null> = {
  branch: () => {
    try {
      return execSync("git branch --show-current", {
        encoding: "utf-8",
        timeout: 2000,
      }).trim() || null;
    } catch {
      return null;
    }
  },
  project: () => {
    try {
      const out = execSync("basename \"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\"", {
        encoding: "utf-8",
        timeout: 2000,
        shell: "/bin/bash",
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  },
  model: (ctx?: Context) => ctx?.agentConfig.model ?? null,
  profile: (ctx?: Context) => ctx?.profile ?? null,
};

function resolveStatusline(format: string, ctx?: Context): string {
  return format.replace(/\{(\w+)\}/g, (_, key: string) => {
    const fn = PLACEHOLDERS[key];
    if (!fn) return `{${key}}`;
    const val = fn.length > 0 ? fn(ctx) : (fn as () => string | null)();
    return val ?? dim("?");
  });
}

class StatuslineCommand implements Command<unknown> {
  description = "Muestra o configura el statusline debajo del prompt.";
  helpShort = "/statusline [on|off|formato]";
  help = [
    "/statusline                    muestra el formato actual",
    "/statusline on                 activa el statusline (usa el último formato)",
    "/statusline off                desactiva el statusline",
    "/statusline <formato>          setea el formato y activa",
    "",
    "Placeholders: {branch} {project} {model} {profile}",
    "Ejemplo: /statusline {project} | {branch} · {model}",
  ];

  async handler(ctx: Context, args: string[]): Promise<void> {
    const arg = args.join(" ").trim();

    if (!arg || arg === "on") {
      // Mostrar o activar
      const current = ctx.session.getMeta(STATUSLINE_KEY) as string | undefined;
      const format = current ?? "{project} · {branch}";
      if (arg === "on" || !current) {
        ctx.session.setMeta(STATUSLINE_KEY, format);
      }
      const resolved = resolveStatusline(format, ctx);
      ctx.screen.setStatusline(dim(resolved));
      if (!arg) {
        ctx.screen.printAbove(
          `Statusline: ${cyan(format)} → ${dim(resolved)}\n` +
          dim("  /statusline off para desactivar, /statusline <formato> para cambiar"),
        );
      } else {
        ctx.screen.printAbove(green(`Statusline activado: ${dim(resolved)}`));
      }
      return;
    }

    if (arg === "off") {
      ctx.screen.setStatusline(null);
      ctx.screen.printAbove(dim("Statusline desactivado."));
      return;
    }

    // Formato personalizado
    ctx.session.setMeta(STATUSLINE_KEY, arg);
    const resolved = resolveStatusline(arg, ctx);
    ctx.screen.setStatusline(dim(resolved));
    ctx.screen.printAbove(`${green("Statusline:")} ${dim(resolved)}`);
  }
}

export { StatuslineCommand, resolveStatusline, STATUSLINE_KEY };