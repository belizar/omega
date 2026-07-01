import { Context } from "../app-context.js";
import { Message, ToolMessage, ToolUseMessage } from "../message.js";
import { Session } from "../session.js";
import { calculateCost } from "../providers/llm-provider.js";
import { DisplayAssistantText } from "../tui/components/display-text.js";
import { SelectList } from "../tui/components/select-list.js";
import { bold, cyan, dim, green } from "../tui/theme.js";
import { Command } from "./command.js";
import { ModalCommand, ModalOpen } from "./modal-command.js";
import { SESSIONS_DIR } from "./session-resume.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
// ── Tipos ────────────────────────────────────────────────────────────────────
interface AnalyzeData {
  id: string;
  name: string;
  model: string;
  savedAt: string;
  messages: Message[];
  totalCost: number;
  totalTokens: { input: number; output: number };
  stepUsage: Array<{ inputTokens: number; outputTokens: number; cachedTokens: number; cost: number; model?: string }>;
  profileTimeline: Array<{ step: number; profile: string }>;
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function loadSessionFile(sessionId: string): AnalyzeData | null {
  const sessionPath = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(sessionPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(sessionPath, "utf-8"));
    return {
      id: parsed.id ?? sessionId,
      name: parsed.name ?? "",
      model: parsed.model ?? "?",
      savedAt: parsed.savedAt ?? "",
      messages: parsed.messages ?? [],
      totalCost: parsed.totalCost ?? 0,
      totalTokens: parsed.totalTokens ?? { input: 0, output: 0 },
      stepUsage: parsed.stepUsage ?? [],
      profileTimeline: parsed.profileTimeline ?? [],
    };
  } catch {
    return null;
  }
}
function formatCost(n: number): string {
  return n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`;
}
function countTools(messages: Message[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of messages) {
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of blocks) {
      if (typeof block === "object" && "type" in block && block.type === "tool_use") {
        const name = (block as ToolUseMessage).name;
        counts[name] = (counts[name] || 0) + 1;
      }
    }
  }
  return counts;
}
/** Cantidad de turns (pares user+assistant) con tool calls. */
function countTurns(messages: Message[]): number {
  let turns = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    if (blocks.some((b) => typeof b === "object" && "type" in b && b.type === "tool_use")) turns++;
  }
  return turns;
}
/** Errores repetidos de tools. */
function findErrorPatterns(messages: Message[]): string[] {
  const errors: Record<string, number> = {};
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of blocks) {
      if (typeof block === "object" && "type" in block && block.type === "tool_result" && (block as ToolMessage).is_error) {
        const toolResultBlock = block as ToolMessage & { name?: string };
        const key = `Error en ${toolResultBlock.name ?? "tool"}`;
        errors[key] = (errors[key] || 0) + 1;
      }
    }
  }
  return Object.entries(errors)
    .filter(([, n]) => n >= 2)
    .map(([k, n]) => `${k} (${n} veces)`);
}
// ── Sugerencias ──────────────────────────────────────────────────────────────
function generateSuggestions(data: AnalyzeData): string[] {
  const suggestions: string[] = [];
  const messages = data.messages;
  const steps = data.stepUsage;
  // 1. Reads sin outline previo (aproximación: si hay reads pero 0 outlines)
  const tools = countTools(messages);
  const readCount = tools["read"] ?? 0;
  const outlineCount = tools["outline"] ?? 0;
  if (readCount > 3 && outlineCount === 0) {
    suggestions.push(
      `• ${readCount} reads sin ningún outline: usá outline antes de leer archivos grandes para ahorrar tokens.`,
    );
  } else if (readCount > 0 && outlineCount > 0 && readCount > outlineCount * 3) {
    suggestions.push(
      `• ${readCount} reads vs ${outlineCount} outlines: hacé más outlines antes de leer archivos grandes.`,
    );
  }
  // 2. Steps con mucho output token relativo (verbosidad del LLM)
  if (steps.length > 0) {
    const verboseSteps = steps.filter((s) => s.outputTokens > s.inputTokens * 0.4);
    if (verboseSteps.length >= 3) {
      suggestions.push(
        `• ${verboseSteps.length}/${steps.length} steps con output >40% del input: el LLM fue verborrágico, probá pedirle concisión.`,
      );
    }
  }
  // 3. Caché no aprovechado
  if (steps.length >= 5) {
    const totalCached = steps.reduce((sum, s) => sum + s.cachedTokens, 0);
    const totalInput = steps.reduce((sum, s) => sum + s.inputTokens, 0);
    if (totalCached === 0 && totalInput > 30000) {
      suggestions.push(
        `• 0 tokens en caché con ${totalInput.toLocaleString()} de input: usá prompt caching (tu modelo lo soporta?).`,
      );
    }
  }
  // 4. Errores repetidos
  const errorPatterns = findErrorPatterns(messages);
  if (errorPatterns.length > 0) {
    suggestions.push(`• Errores repetidos: ${errorPatterns.join(", ")}.`);
  }
  // 5. Turnos sin tool calls
  const totalTurns = countTurns(messages);
  let directAnswers = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [msg.content];
    // Solo contar assistant que no son respuesta a tool_result y no tienen tool_use
    if (!blocks.some((b) => typeof b === "object" && "type" in b && b.type === "tool_use") && blocks.some((b) => typeof b === "object" && "type" in b && b.type === "text")) {
      directAnswers++;
    }
  }
  if (directAnswers > totalTurns * 0.5 && totalTurns > 2) {
    suggestions.push(
      `• ${directAnswers} respuestas directas (sin tools): el LLM respondió sin usar herramientas, quizá no exploró bien.`,
    );
  }
  return suggestions;
}
// ── Render ───────────────────────────────────────────────────────────────────
function bar(value: number, max: number, width: number = 12): string {
  if (max === 0) return "";
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
function analyze(data: AnalyzeData, compact = false): string {
  const lines: string[] = [];
  // ── Header ──
  const label = data.name ? `"${data.name}"` : "(sin nombre)";
  const date = data.savedAt ? new Date(data.savedAt).toLocaleString() : "?";
  const totalTurns = countTurns(data.messages);
  lines.push(`📊 Análisis: ${label}`);
  lines.push(
    `⏱️  ${date} · ${data.messages.length} msgs · ${totalTurns} turns · ${data.model}`,
  );
  lines.push("");
  // ── Costo ──
  const inputTokens = data.totalTokens.input;
  const outputTokens = data.totalTokens.output;
  const totalCached = data.stepUsage.reduce((s, c) => s + c.cachedTokens, 0);
  lines.push(`💰 Costo total: ${formatCost(data.totalCost)}`);
  lines.push(`   Input:   ${inputTokens.toLocaleString()} tk → ${formatCost(data.stepUsage.length === 0 ? calculateCost(data.model, inputTokens, 0) : data.stepUsage.reduce((s, st) => s + st.cost * (st.inputTokens / (st.inputTokens + st.outputTokens)), 0))}`);
  lines.push(`   Output:  ${outputTokens.toLocaleString()} tk → ${formatCost(data.stepUsage.length === 0 ? calculateCost(data.model, 0, outputTokens) : data.stepUsage.reduce((s, st) => s + st.cost * (st.outputTokens / (st.inputTokens + st.outputTokens)), 0))}`);
  // Si hay cached tokens, mostrarlo
  if (totalCached > 0) {
    // Estimar el ahorro: cached usa pricing de input con descuento típico de 90%
    const cachedCost = (totalCached / 1_000_000) * 0.10; // asumiendo ~10% del costo de input
    lines.push(`   Cached:  ${totalCached.toLocaleString()} tk (ahorro ~${formatCost(cachedCost)})`);
  }
  lines.push("");
  // ── Tools ──
  const tools = countTools(data.messages);
  const totalCalls = Object.values(tools).reduce((s, c) => s + c, 0);
  const maxCalls = Math.max(...Object.values(tools), 1);
  if (totalCalls > 0) {
    const sorted = Object.entries(tools).sort((a, b) => b[1] - a[1]);
    lines.push(`🔧 Tools (${totalCalls} llamadas)`);
    for (const [name, count] of sorted) {
      lines.push(`   ${name.padEnd(14)} ${bar(count, maxCalls)} ${count}`);
    }
    lines.push("");
  }
  // ── Progresión por step ──
  if (data.stepUsage.length > 0) {
    lines.push("📈 Progresión por step");
    for (let i = 0; i < data.stepUsage.length; i++) {
      const s = data.stepUsage[i];
      const cacheInfo = s.cachedTokens > 0 ? ` cache:${(s.cachedTokens / 1000).toFixed(1)}K` : "";
      const modelLabel = s.model ? ` ${dim("[" + s.model.split("/").pop()?.split("-").slice(0, 2).join("-") + "]")}` : "";
      lines.push(
        `   ${String(i + 1).padStart(2)}. in:${(s.inputTokens / 1000).toFixed(1)}K out:${(s.outputTokens / 1000).toFixed(1)}K${cacheInfo} → ${formatCost(s.cost)}${modelLabel}`,
      );
    }
    lines.push("");

    // Costo por modelo
    const costByModel: Record<string, number> = {};
    for (const s of data.stepUsage) {
      const m = s.model || "?";
      costByModel[m] = (costByModel[m] || 0) + s.cost;
    }
    if (Object.keys(costByModel).length > 1) {
      lines.push("💰 Costo por modelo");
      for (const [model, cost] of Object.entries(costByModel).sort((a, b) => b[1] - a[1])) {
        const short = model.split("/").pop() ?? model;
        lines.push(`   ${short.padEnd(25)} ${formatCost(cost)}`);
      }
      lines.push("");
    }
  }

  // ── Sugerencias ──
  const suggestions = generateSuggestions(data);
  if (suggestions.length > 0) {
    lines.push("💡 Sugerencias");
    for (const s of suggestions) {
      lines.push(s);
    }
    lines.push("");
  } else {
    lines.push("💡 Nada que sugerir, ¡buen uso!");
    lines.push("");
  }
  // ── Resumen ──
  const costPerStep = data.stepUsage.length > 0
    ? data.totalCost / data.stepUsage.length
    : 0;
  lines.push(`📋 ${totalTurns} turns · ${totalCalls} tools · ${formatCost(data.totalCost)} total · ~${formatCost(costPerStep)}/step`);
  return lines.join("\n");
}

// ── Row renderer para el picker ──────────────────────────────────────────────

function renderSessionRow(
  s: SessionSummary,
  index: number,
  isSelected: boolean,
): string {
  const marker = isSelected ? cyan("❯ ") : "  ";
  const num = green(`[${index + 1}]`);
  const name = s.name ? ` ${cyan(s.name)} ` : " ";
  const id = bold(s.id.slice(0, 8)) + "...";
  const cost = s.totalCost < 0.01 ? "<$0.01" : `$${s.totalCost.toFixed(2)}`;
  const model = s.model ? ` ${dim(s.model)}` : "";
  const date = s.savedAt ? new Date(s.savedAt).toLocaleString() : "?";
  return `${marker}${num}${name}${id}  ${s.messageCount} msgs  ${cost}${model}  ${dim(date)}`;
}
type SessionSummary = ReturnType<typeof Session.listSessions>[number];
// ── Comando directo /analyze raw|<id|n|this> ─────────────────────────────────
class AnalyzeCommand implements Command<void> {
  description =
    "Muestra el reporte crudo de una sesión: /analyze raw [<id|n|this>].";
  handler(_ctx: Context, args: string[]): void {
    const display = new DisplayAssistantText(_ctx.screen);
    if (args[0] === "raw") {
      // /analyze raw → sesión actual; /analyze raw <id|n|this> → específica
      const target = args[1];
      this.#showRaw(_ctx, target, display);
      return;
    }
    // /analyze this → reporte crudo de la sesión actual
    if (args[0] === "this") {
      this.#showCurrent(_ctx, display);
      return;
    }
    // /analyze <id|n> → reporte crudo por ID o índice
    if (args.length > 0) {
      this.#showById(_ctx, args[0], display);
      return;
    }
    display.display("Usos: /analyze (selector + LLM), /analyze raw [<id|n|this>] (solo reporte).");
  }
  #showRaw(ctx: Context, target: string | undefined, display: DisplayAssistantText): void {
    let data: AnalyzeData | null;
    if (!target || target === "this") {
      data = this.#currentSessionData(ctx);
    } else {
      data = this.#findSession(target);
    }
    if (!data) {
      display.display(`Sesión no encontrada: "${target}".`);
      return;
    }
    display.display(analyze(data));
  }
  #showCurrent(ctx: Context, display: DisplayAssistantText): void {
    display.display(analyze(this.#currentSessionData(ctx)));
  }
  #showById(ctx: Context, arg: string, display: DisplayAssistantText): void {
    const data = this.#findSession(arg);
    if (!data) {
      display.display(
        `No se encontró sesión con id/índice "${arg}". Usá /analyze para ver la lista.`,
      );
      return;
    }
    display.display(analyze(data));
  }
  #currentSessionData(ctx: Context): AnalyzeData {
    const session = ctx.session;
    return {
      id: session.id,
      name: session.info().name,
      model: session.model,
      savedAt: "",
      messages: [...session.messages],
      totalCost: session.totalCost,
      totalTokens: session.totalTokens,
      stepUsage: [...session.stepUsage],
      profileTimeline: [...session.profileTimeline],
    };
  }

  #findSession(arg: string): AnalyzeData | null {
    const sessions = Session.listSessions(SESSIONS_DIR);
    let sessionId: string | undefined;
    const index = parseInt(arg, 10);
    if (!isNaN(index) && index >= 1 && index <= sessions.length) {
      sessionId = sessions[index - 1].id;
    } else {
      sessionId = sessions.find((s) => s.id.startsWith(arg))?.id;
    }
    if (!sessionId) return null;
    return loadSessionFile(sessionId);
  }
}

// ── Comando modal /analyze (pelado) ──────────────────────────────────────────
const analyzeModalCommand: ModalCommand = {
  name: "/analyze",
  open(_ctx: Context): ModalOpen {
    const sessions = Session.listSessions(SESSIONS_DIR);
    if (sessions.length === 0) {
      return { message: "No hay sesiones guardadas." };
    }
    const rows = process.stdout.rows || 24;
    const maxVisible = Math.max(3, Math.min(20, rows - 7));
    return { picker: new SelectList(sessions, renderSessionRow, maxVisible) };
  },
  apply(ctx: Context, value: unknown): string {
    const s = value as SessionSummary;
    const data = loadSessionFile(s.id);
    if (!data) return `Sesión "${s.id}" corrupta o inaccesible.`;
    const report = analyze(data);
    const prompt = [
      "Analizá el siguiente reporte de sesión de Omega y dame recomendaciones:",
      "",
      "```",
      report,
      "```",
      "",
      "Interpretá los patrones de uso de herramientas, costo, y sugerí mejoras concretas. Sé conciso.",
    ].join("\n");
    ctx.session.injectUserMessage(prompt);
    return `📊 Analizando sesión "${data.name || data.id.slice(0, 8)}"...`;
  },
};
export { AnalyzeCommand, analyzeModalCommand };