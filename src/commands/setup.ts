import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";
import { Context } from "../app-context.js";
import { DisplayAssistantText } from "../tui/components/display-text.js";
import { bold, cyan, dim, green, red, yellow } from "../tui/theme.js";
import { Command } from "./command.js";
import { outlineFile, outlineDir } from "../tools/outline-extract.js";

const HOME = homedir();
const CWD = process.cwd();

// ── Tipos ────────────────────────────────────────────────────────────────────

interface DiagItem {
  label: string;
  path: string;
  status: "ok" | "warn" | "missing";
  detail?: string;
}

// ── Diagnóstico ──────────────────────────────────────────────────────────────

function runDiagnostic(): DiagItem[] {
  const items: DiagItem[] = [];

  const globalEnv = join(HOME, ".omega", ".env");
  if (existsSync(globalEnv)) {
    const content = readFileSync(globalEnv, "utf-8");
    const hasKey = /OPENROUTER_API_KEY|ANTHROPIC_API_KEY/.test(content);
    items.push({
      label: "~/.omega/.env",
      path: globalEnv,
      status: hasKey ? "ok" : "warn",
      detail: hasKey ? "API key configurada" : "sin API key",
    });
  } else {
    items.push({ label: "~/.omega/.env", path: globalEnv, status: "missing" });
  }

  const globalCfg = join(HOME, ".omega", "config.json");
  if (existsSync(globalCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(globalCfg, "utf-8"));
      const names = Object.keys(cfg.profiles ?? {});
      items.push({
        label: "~/.omega/config.json",
        path: globalCfg,
        status: "ok",
        detail: `${names.length} perfil(es): ${names.join(", ")}`,
      });
    } catch {
      items.push({ label: "~/.omega/config.json", path: globalCfg, status: "warn", detail: "JSON inválido" });
    }
  } else {
    items.push({ label: "~/.omega/config.json", path: globalCfg, status: "missing" });
  }

  const projectCfg = join(CWD, ".omega", "config.json");
  items.push({
    label: ".omega/config.json",
    path: projectCfg,
    status: existsSync(projectCfg) ? "ok" : "missing",
    detail: existsSync(projectCfg) ? "config local" : "hereda del global",
  });

  const agentMd = join(CWD, "AGENT.md");
  items.push({
    label: "AGENT.md",
    path: agentMd,
    status: existsSync(agentMd) ? "ok" : "missing",
    detail: existsSync(agentMd) ? "contexto del proyecto" : "Omega no tiene contexto",
  });

  const envKey = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
  items.push({
    label: "API key (env)",
    path: "—",
    status: envKey ? "ok" : "warn",
    detail: envKey ? "detectada" : "no detectada",
  });

  return items;
}

// ── Generación de AGENT.md ───────────────────────────────────────────────────
// Delega en el LLM (el propio Omega) para que explore el repo con sus tools y
// escriba AGENT.md. Mucho más potente que cualquier heurística hardcodeada.

// ── Comando ──────────────────────────────────────────────────────────────────

class SetupCommand implements Command<void> {
  description = "Prepara Omega para este proyecto: /setup [diag|agent]";

  handler(ctx: Context, args: string[]): void {
    const display = new DisplayAssistantText(ctx.screen);
    const sub = args[0];

    if (!sub || sub === "diag") {
      this.#printDiag(display);
      return;
    }

    if (sub === "agent") {
      this.#generateAgent(ctx, display);
      return;
    }

    if (sub === "wizard") {
      this.#runWizard(ctx, display);
      return;
    }

    display.display(
      `Usos:\n  ${cyan("/setup")}        → diagnóstico\n  ${cyan("/setup wizard")} → guía interactiva paso a paso\n  ${cyan("/setup agent")}  → generar/actualizar AGENT.md`,
    );
  }

  #printDiag(display: DisplayAssistantText): void {
    const items = runDiagnostic();
    const lines: string[] = ["", "🔍 Omega en este proyecto", ""];

    let ok = 0, warn = 0, miss = 0;
    for (const item of items) {
      const icon = item.status === "ok" ? green("  ✓")
        : item.status === "warn" ? yellow("  ⚠")
        : red("  ✗");
      const detail = item.detail ? ` ${dim(`(${item.detail})`)}` : "";
      lines.push(`${icon} ${item.label}${detail}`);
      if (item.status === "ok") ok++;
      else if (item.status === "warn") warn++;
      else miss++;
    }

    lines.push("");
    const parts: string[] = [];
    if (ok > 0) parts.push(green(`${ok} ok`));
    if (warn > 0) parts.push(yellow(`${warn} advertencias`));
    if (miss > 0) parts.push(red(`${miss} faltantes`));
    lines.push(`${parts.join(" · ")}`);

    if (miss > 0 || warn > 0) {
      lines.push("");
      const actions: string[] = [];
      const hasGlobalEnv = items.find(i => i.label === "~/.omega/.env");
      const hasGlobalCfg = items.find(i => i.label === "~/.omega/config.json");
      const hasAgent = items.find(i => i.label === "AGENT.md");

      if (hasGlobalEnv?.status === "missing") {
        actions.push(`  • Creá ${cyan("~/.omega/.env")} con: ${dim("OPENROUTER_API_KEY=sk-or-...")}`);
      }
      if (hasGlobalCfg?.status === "missing") {
        actions.push(`  • Creá ${cyan("~/.omega/config.json")} (ver docs)`);
      }
      if (hasAgent?.status === "missing") {
        actions.push(`  • Ejecutá ${cyan("/setup agent")} para generar AGENT.md`);
      }
      if (actions.length > 0) {
        lines.push("Para arreglar:");
        lines.push(...actions);
      }
    }

    display.display(lines.join("\n"));
  }

  #generateAgent(ctx: Context, display: DisplayAssistantText): void {
    const exists = existsSync(join(CWD, "AGENT.md"));

    const prompt = exists
      ? `El usuario ejecutó /setup agent. Explorá el proyecto a fondo con tus tools (ls, read, outline, grep) y actualizá AGENT.md.
El archivo ya existe — leelo primero, entendé qué tiene, y agregá/mejorá secciones según lo que descubras.
No te limites a lo obvio: leé entry points, configuración, tests, y mencioná patrones y convenciones que detectes.
Cuando termines, informá qué cambió.`
      : `El usuario ejecutó /setup agent. Explorá el proyecto a fondo con tus tools (ls, read, outline, grep) y creá AGENT.md desde cero.
Empezá por package.json y la estructura de directorios. Identificá entry points, arquitectura, stack, convenciones.
Escribí un AGENT.md conciso pero completo que le sirva a futuros turnos de Omega para entender este codebase.
Cuando termines, informá qué generaste.`;

    ctx.session.injectUserMessage([{ type: "text", text: prompt }]);
    display.display(green(exists
      ? "✓ Omega va a explorar el proyecto y actualizar AGENT.md."
      : "✓ Omega va a explorar el proyecto y crear AGENT.md."));
  }

  // ── Wizard interactivo ────────────────────────────────────────────────

  async #runWizard(ctx: Context, display: DisplayAssistantText): Promise<void> {
    const items = runDiagnostic();
    display.display(["", "🧙 Wizard de setup", "", "Vamos paso a paso.", ""].join("\n"));

    // Step 1: API key
    const envItem = items.find(i => i.label === "~/.omega/.env");
    const envKeyItem = items.find(i => i.label === "API key (env)");

    if (envItem?.status === "missing" && envKeyItem?.status !== "ok") {
      display.display(yellow("⚠  No se detectó API key."));
      display.display(dim("  Pegá tu OpenRouter API key (o Enter para saltear):"));
      const key = await ctx.screen.askUser("API key");
      if (key && key.trim()) {
        const { mkdirSync, writeFileSync: wfs } = await import("fs");
        const envDir = join(HOME, ".omega");
        if (!existsSync(envDir)) mkdirSync(envDir, { recursive: true });
        const envPath = join(envDir, ".env");
        const existing = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
        const newContent = existing.includes("OPENROUTER_API_KEY")
          ? existing.replace(/OPENROUTER_API_KEY=.*/g, `OPENROUTER_API_KEY=${key.trim()}`)
          : existing.trimEnd() + `\nOPENROUTER_API_KEY=${key.trim()}\n`;
        wfs(envPath, newContent, "utf-8");
        // Setearla en el proceso actual también
        process.env.OPENROUTER_API_KEY = key.trim();
        display.display(green("✓ API key guardada en ~/.omega/.env"));
      }
    } else {
      display.display(green("✓ API key detectada"));
    }

    display.display("");

    // Step 2: AGENT.md
    const agentItem = items.find(i => i.label === "AGENT.md");
    if (agentItem?.status === "missing") {
      display.display(yellow("⚠  No hay AGENT.md en este proyecto."));
      display.display(dim("  Omega lo usa para entender tu codebase."));
      const answer = await ctx.screen.askUser("¿Generar AGENT.md? (s/n)");
      if (answer.toLowerCase().startsWith("s")) {
        this.#generateAgent(ctx, display);
      }
    } else {
      display.display(green("✓ AGENT.md presente"));
    }

    display.display("");

    // Step 3: Config global
    const globalCfg = items.find(i => i.label === "~/.omega/config.json");
    if (globalCfg?.status === "missing") {
      display.display(yellow("⚠  No hay config.json global."));
      display.display(dim("  Define perfiles (modelos, tokens, etc.)."));
      const answer = await ctx.screen.askUser("¿Crear config.json con perfiles default y deep? (s/n)");
      if (answer.toLowerCase().startsWith("s")) {
        const { mkdirSync, writeFileSync: wfs } = await import("fs");
        const cfgDir = join(HOME, ".omega");
        if (!existsSync(cfgDir)) mkdirSync(cfgDir, { recursive: true });
        const cfg = {
          defaultProfile: "default",
          profiles: {
            default: { model: "anthropic/claude-haiku-4-5-20251001", maxTokens: 4096, maxSteps: 15, maxContextTokens: 100000 },
            deep: { model: "anthropic/claude-sonnet-4-5", maxTokens: 8192, maxSteps: 25, maxContextTokens: 100000 },
          },
        };
        wfs(join(cfgDir, "config.json"), JSON.stringify(cfg, null, 2), "utf-8");
        display.display(green("✓ config.json creado con perfiles 'default' y 'deep'"));
      }
    } else {
      display.display(green("✓ config.json presente"));
    }

    display.display("");
    display.display(bold("✨ Setup completo. Ejecutá /setup para ver el diagnóstico final."));
    display.display(dim("Tip: usá /profile deep para cambiar a Sonnet cuando necesites más potencia."));
  }
}

export { SetupCommand };