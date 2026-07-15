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

/** Un diagrama emitido por la review (mermaid), renderizado en el web. Fase 3. */
export interface ReviewDiagram {
  title: string;
  kind: "sequence" | "class" | "flow" | "state";
  mermaid: string;
}

/** Lo que produce el LLM: los pasos (+ diagramas, fase 3). El anclaje a git y la
 *  metadata de persistencia los agrega el store alrededor. */
export interface ReviewContent {
  steps: ReviewStep[];
  diagrams: ReviewDiagram[];
}

/** Una review persistida: el contenido + su identidad (anclada al DIFF, no al
 *  commit) y metadata. Ver docs/design/omega-guide-review.md. */
export interface ReviewGuide extends ReviewContent {
  /** Contra qué se revisó (null = cambios sin commitear). */
  base: string | null;
  /** Commit actual del workspace — solo para display ("vs main, en a3f21c"). */
  headSha: string | null;
  /** Hash del contenido del diff → identidad + detección de staleness. */
  fingerprint: string;
  /** El ángulo de la review (prompt libre). "" = general. Fase 2. */
  lens: string;
  createdAt: number;
}

/** Arma el system prompt según la lente (ángulo) y si se piden diagramas. */
function buildSystem(lens: string, diagrams: boolean): string {
  const schema = diagrams
    ? `{"steps":[{"title":"Título corto","rationale":"Qué cambia y por qué, 1-3 oraciones.","files":["path/al/archivo"]}],"diagrams":[{"title":"Título del diagrama","kind":"sequence","mermaid":"sequenceDiagram\\n  Cliente->>API: request\\n  API-->>Cliente: response"}]}`
    : `{"steps":[{"title":"Título corto","rationale":"Qué cambia y por qué, 1-3 oraciones.","files":["path/al/archivo","otro/path"]}]}`;

  const parts = [
    `Sos un revisor de código senior. Te dan el diff de un cambio y armás una GUÍA DE REVIEW para que un humano lo revise fácil.`,
    `Partí el cambio en PASOS lógicos ordenados por dependencia (lo que hay que entender primero va primero — ej. una migración de DB o un tipo nuevo antes del código que lo usa). Cada paso agrupa archivos relacionados y explica el QUÉ cambia y el PORQUÉ, en prosa clara y concisa.`,
  ];
  if (lens.trim()) {
    parts.push(
      `ENFOQUE: revisá el cambio desde esta perspectiva concreta: "${lens.trim()}". Priorizá los pasos, el porqué y (si aplica) los diagramas relevantes a ese ángulo; podés dejar de lado lo que no toca esa mirada.`,
    );
  }
  if (diagrams) {
    parts.push(
      `DIAGRAMAS: si un diagrama ayuda a entender el flujo o el modelo, incluí uno o más en "diagrams" (sintaxis mermaid válida). Usá sequenceDiagram para flujos (request/response, orquestación), classDiagram para modelo de dominio/tipos, flowchart para lógica. Solo si aporta — no fuerces diagramas triviales.`,
    );
  }
  parts.push(`Respondé SOLO con un objeto JSON válido (sin markdown, sin texto extra, sin \`\`\`), con esta forma exacta:\n${schema}`);
  parts.push(`Reglas: los "files" deben ser paths que aparecen en el diff. No inventes archivos. Ordená los pasos deps-primero. Respondé en español.`);
  return parts.join("\n\n");
}

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

const DIAGRAM_KINDS = ["sequence", "class", "flow", "state"] as const;

/** Saca ```json fences y ruido alrededor del JSON, y parsea steps + diagrams. */
function parseGuide(text: string): ReviewContent {
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
  const diagrams: ReviewDiagram[] = Array.isArray(raw?.diagrams)
    ? raw.diagrams
        .map((d: Record<string, unknown>): ReviewDiagram => {
          const kind = String(d?.kind ?? "");
          return {
            title: String(d?.title ?? "").trim() || "Diagrama",
            kind: (DIAGRAM_KINDS as readonly string[]).includes(kind) ? (kind as ReviewDiagram["kind"]) : "sequence",
            mermaid: String(d?.mermaid ?? "").trim(),
          };
        })
        .filter((d: ReviewDiagram) => d.mermaid.length > 0)
    : [];
  return { steps, diagrams };
}

/**
 * Genera un review guiado de un diff con una llamada LLM enfocada (una sola, sin
 * tools, sin el loop del agente). Es la "skill" de guided-review: el modelo lee el
 * diff y devuelve pasos ordenados con su porqué; la UI los renderiza.
 */
export async function generateReview(
  diff: DiffResult,
  provider: LLMProvider,
  opts: { model: string; maxTokens: number; lens?: string; diagrams?: boolean },
  signal?: AbortSignal,
): Promise<ReviewContent> {
  if (diff.files.length === 0) return { steps: [], diagrams: [] };

  const wantsDiagrams = opts.diagrams ?? false;
  const agent = new AgentConfig({
    systemPrompt: buildSystem(opts.lens ?? "", wantsDiagrams),
    model: opts.model,
    // los diagramas gastan más tokens: subimos el piso cuando se piden.
    maxTokens: Math.max(opts.maxTokens, wantsDiagrams ? 4500 : 3000),
    toolRegistry: new ToolRegistry(), // sin tools: queremos texto/JSON, no acciones
    temperature: 0.2, // determinístico-ish: un review no es creativo
  });

  const user = `Diff a revisar (${diff.totals.files} archivos, +${diff.totals.additions} -${diff.totals.deletions}):\n\n${serializeDiff(diff)}`;
  const res = await provider.call([{ role: "user", content: user }], agent, signal);
  const text = res.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  return parseGuide(text);
}
