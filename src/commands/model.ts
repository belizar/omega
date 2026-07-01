import { Context } from "../app-context.js";
import { DisplayAssistantText } from "../tui/components/display-text.js";
import { bold, cyan, dim, green } from "../tui/theme.js";
import { Command } from "./command.js";

const VALID_AGENTS = ["primary", "vision", "classifier"] as const;
type Agent = (typeof VALID_AGENTS)[number];

class ModelCommand implements Command<void> {
  description = "Override de modelo: /model [primary|vision|classifier <modelo>|reset]";

  handler(ctx: Context, args: string[]): void {
    const display = new DisplayAssistantText(ctx.screen);
    const session = ctx.session;

    if (args.length === 0) {
      // Mostrar estado actual
      const overrides = session.modelOverrides;
      const lines: string[] = [];
      for (const agent of VALID_AGENTS) {
        const override = overrides[agent];
        if (override) {
          lines.push(`  ${cyan(agent.padEnd(12))} ${green("~")} ${override} ${dim("(override)")}`);
        } else {
          lines.push(`  ${agent.padEnd(12)} ${dim("(sin override)")}`);
        }
      }
      if (lines.length === 0) {
        display.display("Sin overrides de modelo.");
      } else {
        display.display(lines.join("\n"));
      }
      return;
    }

    if (args[0] === "reset") {
      session.resetModelOverrides();
      display.display(`${green("✓")} Overrides limpiados. Volviendo a defaults del perfil.`);
      return;
    }

    const agent = args[0] as Agent;
    if (!VALID_AGENTS.includes(agent)) {
      display.display(`Agente inválido: "${args[0]}". Usá: ${cyan("primary")}, ${cyan("vision")}, ${cyan("classifier")}.`);
      return;
    }

    if (args.length === 1) {
      // Limpiar override para este agente
      session.setModelOverride(agent, null);
      display.display(`${green("✓")} Override de ${bold(agent)} removido.`);
      return;
    }

    const model = args[1];
    session.setModelOverride(agent, model);
    display.display(`${green("✓")} ${bold(agent)} → ${cyan(model)} (próximo turno).`);
  }
}

export { ModelCommand };