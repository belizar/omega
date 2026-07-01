import { Context } from "../app-context.js";
import { listProfiles, getProfileByName } from "../config.js";
import { DisplayAssistantText } from "../tui/components/display-text.js";
import { bold, cyan, dim, green, yellow } from "../tui/theme.js";
import { Command } from "./command.js";

class ProfileCommand implements Command<void> {
  description = "Maneja perfiles: /profile [list|<nombre>]";

  handler(ctx: Context, args: string[]): void {
    const display = new DisplayAssistantText(ctx.screen);
    const session = ctx.session;

    if (args.length === 0) {
      // Mostrar perfil activo
      display.display(
        `${green("●")} Perfil activo: ${bold(session.profile)}${session.modelOverrides.primary || session.modelOverrides.vision || session.modelOverrides.classifier ? yellow(" (con overrides)") : ""}`,
      );
      return;
    }

    if (args[0] === "list") {
      const { names, active, defaultProfile } = listProfiles(session.profile);
      const lines: string[] = [""];
      for (const name of names) {
        const marker = name === active ? green("●") : " ";
        const isDefault = name === defaultProfile ? dim(" (default)") : "";
        const profile = getProfileByName(name);
        const model = profile ? dim(`  → ${profile.model}`) : "";
        lines.push(`${marker} ${name === active ? bold(name) : name}${isDefault}${model}`);
      }
      display.display(lines.join("\n"));
      return;
    }

    // Activar perfil
    const name = args[0];
    const profile = getProfileByName(name);
    if (!profile) {
      display.display(`Perfil "${name}" no encontrado. Usá ${cyan("/profile list")} para ver los disponibles.`);
      return;
    }

    session.activateProfile(name);
    display.display(`${green("✓")} Perfil cambiado a ${bold(name)} (${dim(profile.model)}). Próximo turno usará este perfil.`);
  }
}

export { ProfileCommand };