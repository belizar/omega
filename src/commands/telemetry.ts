import { Command } from "./command.js";
import { Context } from "../app-context.js";
import { getGlobalSummary, getProject, listProjects, migrateTelemetry } from "../telemetry.js";

/**
 * Muestra costos acumulados de todas las sesiones, a través de todos los proyectos.
 *
 * Sin argumentos: resumen global.
 * <proyecto>: detalle de sesiones de un proyecto.
 * all: tabla de todos los proyectos.
 */
class TelemetryCommand implements Command<void> {
  description = "Muestra estadísticas de costo globales (todos los proyectos).";
  helpShort = "/telemetry [<proyecto> | all]";

  handler(ctx: Context, args: string[]): void {
    // Consolidar registros viejos al esquema de slug por-repo (idempotente).
    const migrated = migrateTelemetry();
    if (migrated.moved > 0) {
      ctx.screen.printAbove(
        `↻ Telemetría migrada: ${migrated.moved} registro(s) reagrupados por repo (${migrated.from.join(", ")}).`,
      );
    }

    const sub = args[0]?.trim();

    if (sub === "all") {
      this.#showAll(ctx);
    } else if (sub) {
      this.#showProject(ctx, sub);
    } else {
      this.#showSummary(ctx);
    }
  }

  #showSummary(ctx: Context): void {
    const summary = getGlobalSummary();

    if (summary.sessionCount === 0) {
      ctx.screen.printAbove(
        "No hay datos de telemetría todavía. Las sesiones se registran automáticamente al guardarse.",
      );
      return;
    }

    const lines: string[] = [];
    lines.push("");
    lines.push("═══════════════════════════════════════════");
    lines.push("          TELEMETRÍA GLOBAL");
    lines.push("═══════════════════════════════════════════");
    lines.push("");
    lines.push(`  Sesiones totales:  ${summary.sessionCount}`);
    lines.push(`  Costo total:       $${summary.totalCost.toFixed(4)} USD`);
    lines.push(
      `  Tokens totales:     ${this.#fmt(summary.totalTokens.input)} in / ${this.#fmt(summary.totalTokens.output)} out`,
    );
    lines.push("");
    lines.push("  Top proyectos por costo:");
    lines.push("  ─────────────────────────────────────────");

    for (const p of summary.projects.slice(0, 10)) {
      const bar = this.#bar(p.totalCost, summary.totalCost, 15);
      lines.push(
        `  ${p.project.padEnd(20)} ${bar} $${p.totalCost.toFixed(4)}  (${p.sessionCount} sesiones)`,
      );
    }

    lines.push("");
    lines.push("  /telemetry all   → tabla de todos los proyectos");
    lines.push("  /telemetry <proyecto>  → detalle de sesiones");
    lines.push("");
    ctx.screen.printAbove(lines.join("\n"));
  }

  #showAll(ctx: Context): void {
    const projects = listProjects();

    if (projects.length === 0) {
      ctx.screen.printAbove("No hay proyectos con telemetría.");
      return;
    }

    const lines: string[] = [];
    lines.push("");
    lines.push("Proyecto              Sesiones   Costo        Tokens (in/out)");
    lines.push("────────────────────  ────────   ──────────   ───────────────");

    for (const p of projects) {
      lines.push(
        `${p.project.padEnd(20)}  ${String(p.sessionCount).padEnd(8)}  $${p.totalCost.toFixed(4).padEnd(10)}  ${this.#fmt(p.totalTokens.input)} / ${this.#fmt(p.totalTokens.output)}`,
      );
    }

    lines.push("");
    ctx.screen.printAbove(lines.join("\n"));
  }

  #showProject(ctx: Context, slug: string): void {
    const project = getProject(slug);

    if (!project) {
      ctx.screen.printAbove(`No hay telemetría para el proyecto "${slug}".`);
      return;
    }

    const lines: string[] = [];
    lines.push("");
    lines.push(`═══════════════════════════════════════════`);
    lines.push(`  ${project.project}  —  ${project.sessionCount} sesiones`);
    lines.push(`  Costo total: $${project.totalCost.toFixed(4)} USD`);
    lines.push(`  Tokens: ${this.#fmt(project.totalTokens.input)} in / ${this.#fmt(project.totalTokens.output)} out`);
    lines.push(`───────────────────────────────────────────`);
    lines.push("");

    for (const s of project.sessions) {
      const date = new Date(s.savedAt).toLocaleDateString("es-AR", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const name = s.name || "(sin nombre)";
      const nameLine = name.length > 30 ? name.slice(0, 29) + "…" : name;
      lines.push(
        `  ${date}  ${nameLine.padEnd(32)} $${s.totalCost.toFixed(4)}  ${this.#fmt(s.totalTokens.input)}/${this.#fmt(s.totalTokens.output)} tok`,
      );
    }

    lines.push("");
    ctx.screen.printAbove(lines.join("\n"));
  }

  #fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  #bar(value: number, total: number, width: number): string {
    if (total === 0) return "░".repeat(width);
    const filled = Math.round((value / total) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
  }
}

export { TelemetryCommand };