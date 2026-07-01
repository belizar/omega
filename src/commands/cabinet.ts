import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { Context } from "../app-context.js";
import { Command } from "./command.js";
import { dim, cyan, green, yellow } from "../tui/theme.js";
import {
  resolveGitRoot,
  resolveProjectCabinet,
  getGlobalCabinet,
  initCabinet,
  countCabinetDocs,
  cabinetHasRemote,
  cabinetIsGitRepo,
} from "../cabinet.js";

// ── /cabinet ────────────────────────────────────────────────────────────

class CabinetCommand implements Command<unknown> {
  description = "Gestiona el cabinet de memoria de largo plazo.";
  helpShort = "/cabinet [init|remote|status]";
  help = [
    "/cabinet                     muestra info del cabinet del proyecto",
    "/cabinet init                crea el cabinet del proyecto (.omega/cabinet/)",
    "/cabinet remote set <url>    configura el remote git del cabinet",
    "/cabinet status              muestra info detallada de ambos cabinets",
  ];

  async handler(ctx: Context, args: string[]): Promise<void> {
    const sub = args[0] ?? "info";

    if (sub === "init") {
      const projectCabinet = resolveProjectCabinet(process.cwd());
      if (projectCabinet) {
        ctx.screen.printAbove(
          yellow(`El cabinet del proyecto ya existe en ${projectCabinet}`),
        );
        return;
      }

      const gitRoot = resolveGitRoot(process.cwd()) ?? process.cwd();
      const path = join(gitRoot, ".omega", "cabinet");
      initCabinet(path);

      // git init
      try {
        execSync("git init", { cwd: path, encoding: "utf-8", timeout: 5000 });
        ctx.screen.printAbove(
          `${green("Cabinet creado:")} ${dim(path)}\n` +
          dim("  git init ✓   Usá /cabinet remote set <url> para configurar un remote."),
        );
      } catch {
        ctx.screen.printAbove(
          `${green("Cabinet creado:")} ${dim(path)}\n` +
          yellow("  git init falló — el cabinet funciona igual, solo sin control de versiones."),
        );
      }
      return;
    }

    if (sub === "remote" && args[1] === "set" && args[2]) {
      const projectCabinet = resolveProjectCabinet(process.cwd());
      if (!projectCabinet) {
        ctx.screen.printAbove(
          yellow("No hay cabinet de proyecto. Creá uno con /cabinet init."),
        );
        return;
      }

      const url = args.slice(2).join(" ");
      try {
        execSync(`git remote add origin ${url}`, {
          cwd: projectCabinet,
          encoding: "utf-8",
          timeout: 5000,
        });
        ctx.screen.printAbove(
          `${green("Remote configurado:")} ${dim(url)}\n` +
          dim("  Usá git push -u origin main para el primer push."),
        );
      } catch (err: any) {
        ctx.screen.printAbove(yellow(`Error: ${err.message}`));
      }
      return;
    }

    if (sub === "status") {
      const projectCabinet = resolveProjectCabinet(process.cwd());
      const globalCabinet = getGlobalCabinet();
      const lines: string[] = [];

      // Proyecto
      if (projectCabinet) {
        const docs = countCabinetDocs(projectCabinet);
        const isGit = cabinetIsGitRepo(projectCabinet);
        const hasRemote = cabinetHasRemote(projectCabinet);
        const url = hasRemote ? this.#getRemoteUrl(projectCabinet) : null;
        lines.push(`${green("Proyecto:")} ${dim(projectCabinet)}`);
        lines.push(`  Docs: ${docs}  ·  Git: ${isGit ? "✓" : "✗"}  ·  Remote: ${url ? dim(url) : "✗"}`);
      } else {
        lines.push(`${dim("Proyecto:")} no existe. Usá /cabinet init.`);
      }

      // Global
      const globalExists = existsSync(globalCabinet);
      if (globalExists) {
        const docs = countCabinetDocs(globalCabinet);
        const isGit = cabinetIsGitRepo(globalCabinet);
        const hasRemote = cabinetHasRemote(globalCabinet);
        const url = hasRemote ? this.#getRemoteUrl(globalCabinet) : null;
        lines.push(`\n${green("Global:")} ${dim(globalCabinet)}`);
        lines.push(`  Docs: ${docs}  ·  Git: ${isGit ? "✓" : "✗"}  ·  Remote: ${url ? dim(url) : "✗"}`);
      } else {
        lines.push(`\n${dim("Global:")} no existe. Se crea automáticamente al primer uso.`);
      }

      ctx.screen.printAbove(lines.join("\n"));
      return;
    }

    // info (default)
    const projectCabinet = resolveProjectCabinet(process.cwd());
    if (projectCabinet) {
      const docs = countCabinetDocs(projectCabinet);
      const hasRemote = cabinetHasRemote(projectCabinet);
      ctx.screen.printAbove(
        `${green("Cabinet:")} ${dim(projectCabinet)}\n` +
        `  ${docs} docs  ·  Git ✓  ·  Remote ${hasRemote ? "✓" : "✗"}\n` +
        dim(`  /cabinet status para info detallada  ·  /cabinet help para ayuda`),
      );
    } else {
      ctx.screen.printAbove(
        `${yellow("No hay cabinet de proyecto.")}\n` +
        dim(`  /cabinet init para crear uno en ${process.cwd()}/.omega/cabinet/`),
      );
    }
  }

  #getRemoteUrl(cabinetPath: string): string | null {
    try {
      return execSync("git remote get-url origin", {
        cwd: cabinetPath,
        encoding: "utf-8",
        timeout: 2000,
      }).trim() || null;
    } catch {
      return null;
    }
  }
}

// ── /remember ───────────────────────────────────────────────────────────

class RememberCommand implements Command<unknown> {
  description = "Señala algo como memorable (el agente evalúa si consolidarlo).";
  helpShort = "/remember <texto>";
  help = [
    "/remember <texto>     marca el texto como memorable para el agente",
    "",
    "No escribe al cabinet directamente. Es una señal débil:",
    "el agente lo pesa más alto en su evaluación de compuerta.",
    "Ejemplo: /remember el parser de TS no soporta import type en ciertos casos",
  ];

  async handler(ctx: Context, args: string[]): Promise<void> {
    const text = args.join(" ").trim();
    if (!text) {
      ctx.screen.printAbove(
        dim("Uso: /remember <texto>. Ej: /remember este patrón de error es sutil y costoso de re-derivar."),
      );
      return;
    }

    // Inyectamos un mensaje de sistema en la sesión como señal débil.
    // Es un user message para que el agente lo vea en el contexto.
    ctx.session.addUserMessage(
      `[SEÑAL DE MEMORIA — el usuario marcó esto como memorable, pesalo en tu compuerta: "${text}"]`,
    );

    ctx.screen.printAbove(
      `${green("Señal registrada:")} ${dim(text)}\n` +
      dim("  El agente lo evaluará en su compuerta al final del turno."),
    );
  }
}

export { CabinetCommand, RememberCommand };
