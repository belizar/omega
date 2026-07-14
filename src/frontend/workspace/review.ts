import { AgentConfig } from "../../agent-config.js";
import { LLMProvider } from "../../providers/llm-provider.js";
import { ToolRegistry } from "../../tools/tool-registry.js";
import { DiffResult } from "./diff.js";

/** Un paso del review guiado: un grupo lógico de cambios con su porqué. */
export interface ReviewStep {
  title: string;
  /** Explicación en prosa del QUÉ cambia y el PORQUÉ. */
  rationale: string;
  /** Archivos que caen en este paso (paths del diff). */
  files: string[];
}

export interface ReviewGuide {
  steps: ReviewStep[];
  /** Contra qué se revisó (null = cambios sin commitear). */
  base: string | null;
}

const SYSTEM = `Sos un revisor de código senior. Te dan el diff de un cambio y armás una GUÍA DE REVIEW para que un humano lo revise fácil.

Partí el cambio en PASOS lógicos ordenados por dependencia (lo que hay que entender primero va primero — ej. una migración de DB o un tipo nuevo antes del código que lo usa). Cada paso agrupa archivos relacionados y explica el QUÉ cambia y el PORQUÉ, en prosa clara y concisa.

Respondé SOLO con un objeto JSON válido (sin markdown, sin texto extra, sin \`\`\`), con esta forma exacta:
{"steps":[{"title":"Título corto del paso","rationale":"Qué cambia y por qué, 1-3 oraciones.","files":["path/al/archivo","otro/path"]}]}

Reglas: los "files" deben ser paths que aparecen en el diff. No inventes archivos. Ordená los pasos deps-primero. Respondé en español.`;

/** Cuánto texto de parche mandamos (tope para no reventar el context). */
const MAX_PATCH_CHARS = 70_000;

/** Serializa el diff a texto para el prompt: por archivo, su estado + parche. */
function serializeDiff(diff: DiffResult): string {
  let budget = MAX_PATCH_CHARS;
  const parts: string[] = [];
  for (const f of diff.files) {
    const header = `### ${f.status.toUpperCase()} ${f.path} (+${f.additions} -${f.deletions})`;
    if (f.binary) {
      parts.push(`${header}\n(binario)`);
      continue;
    }
    let patch = f.patch;
    if (patch.length > budget) patch = patch.slice(0, Math.max(0, budget)) + "\n… (truncado)";
    budget -= patch.length;
    parts.push(`${header}\n${patch}`);
    if (budget <= 0) {
      parts.push(`\n… (${diff.files.length - parts.length} archivos más omitidos por tamaño)`);
      break;
    }
  }
  return parts.join("\n\n");
}

/** Saca ```json fences y ruido alrededor del JSON, y parsea. */
function parseGuide(text: string): { steps: ReviewStep[] } {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // Si hay texto antes/después, quedarse con el primer objeto {…}.
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  const raw = JSON.parse(t);
  const steps: ReviewStep[] = Array.isArray(raw?.steps)
    ? raw.steps.map((s: Record<string, unknown>) => ({
        title: String(s?.title ?? "").trim() || "(sin título)",
        rationale: String(s?.rationale ?? "").trim(),
        files: Array.isArray(s?.files) ? s.files.filter((f: unknown): f is string => typeof f === "string") : [],
      }))
    : [];
  return { steps };
}

/**
 * Genera un review guiado de un diff con una llamada LLM enfocada (una sola, sin
 * tools, sin el loop del agente). Es la "skill" de guided-review: el modelo lee el
 * diff y devuelve pasos ordenados con su porqué; la UI los renderiza.
 */
export async function generateReview(
  diff: DiffResult,
  provider: LLMProvider,
  opts: { model: string; maxTokens: number },
  signal?: AbortSignal,
): Promise<ReviewGuide> {
  if (diff.files.length === 0) return { steps: [], base: diff.base };

  const agent = new AgentConfig({
    systemPrompt: SYSTEM,
    model: opts.model,
    maxTokens: Math.max(opts.maxTokens, 3000),
    toolRegistry: new ToolRegistry(), // sin tools: queremos texto/JSON, no acciones
    temperature: 0.2, // determinístico-ish: un review no es creativo
  });

  const user = `Diff a revisar (${diff.totals.files} archivos, +${diff.totals.additions} -${diff.totals.deletions}):\n\n${serializeDiff(diff)}`;
  const res = await provider.call([{ role: "user", content: user }], agent, signal);
  const text = res.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  const { steps } = parseGuide(text);
  return { steps, base: diff.base };
}
