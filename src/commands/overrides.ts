import { Command } from "./command.js";
import { Context } from "../app-context.js";
import { dim, bold } from "../tui/theme.js";

export class OverridesCommand implements Command<void> {
  description = "Gestiona overrides del clasificador de comandos. Sin argumentos: lista todos.";

  async handler(ctx: Context, args: string[]): Promise<void> {
    const classifier = ctx.classifier;
    if (!classifier) {
      ctx.screen.printAbove(
        dim("El clasificador de comandos no está activo en esta sesión."),
      );
      return;
    }

    const overrides = classifier.overrides;

    if (args.length === 0 || (args.length === 1 && args[0] === "list")) {
      const list = overrides.list();
      if (list.length === 0) {
        ctx.screen.printAbove(
          dim("No hay overrides definidos. Se crearán automáticamente al usar el clasificador."),
        );
        return;
      }

      const lines: string[] = [bold("Overrides del clasificador:")];
      for (const o of list) {
        const icon = o.verdict === "safe" ? "✓" : "✗";
        const src = o.source === "manual" ? "manual" : "aprendido";
        const cnt = o.count ? ` (x${o.count})` : "";
        lines.push(
          `  ${icon} ${o.verdict.toUpperCase()}  ${o.pattern}  ${dim(`[${src}${cnt}]`)}`,
        );
        if (o.reason) {
          lines.push(`    ${dim(o.reason)}`);
        }
      }
      ctx.screen.printAbove(lines.join("\n"));
      return;
    }

    if (args[0] === "add" && args.length >= 3) {
      const verdict = args[1] as "safe" | "dangerous";
      if (verdict !== "safe" && verdict !== "dangerous") {
        ctx.screen.printAbove(dim("Uso: /overrides add safe|dangerous \"patron\" [razón]"));
        return;
      }
      const pattern = args[2];
      const reason = args.slice(3).join(" ") || "";
      await overrides.add({ pattern, verdict, reason, source: "manual" });
      ctx.screen.printAbove(
        `Override agregado: ${verdict.toUpperCase()} "${pattern}"`,
      );
      return;
    }

    if (args[0] === "remove" && args.length >= 2) {
      const pattern = args[1];
      const removed = await overrides.remove(pattern);
      if (removed) {
        ctx.screen.printAbove(`Override eliminado: "${pattern}"`);
      } else {
        ctx.screen.printAbove(
          dim(`No se encontró un override manual con patrón "${pattern}"`),
        );
      }
      return;
    }

    ctx.screen.printAbove(
      dim("Uso: /overrides [list|add safe|dangerous \"patron\" [razón]|remove \"patron\"]"),
    );
  }
}
