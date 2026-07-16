import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Tool } from "./tool.js";

const DEFAULT_INDEX_PATH = join(homedir(), ".omega", "index.json");
const MAX_READ_CHARS = 40_000;
const MAX_SEARCH_RESULTS = 40;

interface Entry {
  id: string;
  title: string;
  project: string;
  sessionFile: string;
  createdAt?: number;
  lastActive?: number;
  archived?: boolean;
}

interface SessionsInput {
  action: "list" | "search" | "read";
  /** filtro por proyecto (substring del path) — list/search */
  project?: string;
  /** texto a buscar en los transcripts — search */
  query?: string;
  /** id (completo o corto de 8) de la sesión a leer — read */
  id?: string;
  maxResults?: number;
  maxChars?: number;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}
function projectName(p: string): string {
  return p ? p.split("/").slice(-2).join("/") : "(sin proyecto)";
}

/** Aplana un transcript a texto: user + assistant + marcadores de qué tools se
 *  usaron. Los OUTPUTS de las tools se OMITEN a propósito: pueden traer secrets
 *  (privacidad) y no aportan a la señal de comportamiento. */
function flatten(sessionFile: string, maxChars: number): string {
  let t: { messages?: Array<{ role: string; content: unknown }> };
  try {
    t = JSON.parse(readFileSync(sessionFile, "utf-8"));
  } catch {
    return "(no se pudo leer el transcript)";
  }
  const parts: string[] = [];
  for (const m of t.messages ?? []) {
    const blocks = Array.isArray(m.content) ? m.content : [m.content];
    for (const b of blocks as Array<unknown>) {
      if (typeof b === "string") {
        if (b.trim()) parts.push(`${m.role}: ${b.trim()}`);
      } else if (b && typeof b === "object") {
        const blk = b as { type?: string; text?: string; name?: string };
        if (blk.type === "text" && blk.text?.trim()) parts.push(`${m.role}: ${blk.text.trim()}`);
        else if (blk.type === "tool_use") parts.push(`[${m.role} usó tool: ${blk.name}]`);
        // tool_result: omitido (privacidad + ruido)
      }
    }
  }
  let out = parts.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + "\n… (truncado)";
  return out;
}

/**
 * Acceso de SOLO LECTURA al corpus de sesiones pasadas de Omega — la base de la
 * "meta-sesión": un modelo fuerte explora las trazas reales para ayudar a mejorar
 * el system prompt de Omega. list/search/read, driven por el agente.
 */
export class SessionsTool extends Tool<SessionsInput, string> {
  #indexPath: string;

  constructor(indexPath: string = DEFAULT_INDEX_PATH) {
    super({
      name: "sessions",
      description:
        "Acceso de solo-lectura al corpus de sesiones pasadas de Omega (meta-análisis: mejorar el system prompt, entender patrones de uso). Acciones: 'list' (lista sesiones, filtrable por proyecto), 'search' (busca texto en los transcripts, filtrable por proyecto), 'read' (lee el transcript de una sesión por id). Los outputs de las tools se omiten (privacidad): ves user + assistant + qué tools se usaron.",
      schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "search", "read"], description: "list | search | read" },
          project: { type: "string", description: "filtro por proyecto (substring del path), para list/search" },
          query: { type: "string", description: "texto a buscar en los transcripts (search)" },
          id: { type: "string", description: "id completo o corto (8 chars) de la sesión a leer (read)" },
          maxResults: { type: "number", description: "tope de resultados (list/search)" },
          maxChars: { type: "number", description: "tope de caracteres del transcript (read)" },
        },
        required: ["action"],
      },
    });
    this.#indexPath = indexPath;
  }

  #load(): Entry[] {
    try {
      const raw = JSON.parse(readFileSync(this.#indexPath, "utf-8"));
      const arr: Entry[] = Array.isArray(raw) ? raw : (raw.sessions ?? []);
      return arr.filter((e) => e && e.id && !e.archived);
    } catch {
      return [];
    }
  }

  async execute(input: SessionsInput): Promise<string> {
    const entries = this.#load();
    if (entries.length === 0) return "No hay sesiones en el índice.";
    const byProject = (list: Entry[]): Entry[] =>
      input.project ? list.filter((e) => (e.project || "").toLowerCase().includes(input.project!.toLowerCase())) : list;
    const recent = (list: Entry[]): Entry[] => [...list].sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));

    if (input.action === "list") {
      const list = recent(byProject(entries)).slice(0, input.maxResults ?? 60);
      const lines = list.map((e) => `${shortId(e.id)}  ${projectName(e.project)}  ·  ${e.title}`);
      return `${list.length} sesiones${input.project ? ` en "${input.project}"` : ""}:\n\n${lines.join("\n")}`;
    }

    if (input.action === "search") {
      if (!input.query) return "Falta 'query'.";
      const q = input.query.toLowerCase();
      const cap = input.maxResults ?? MAX_SEARCH_RESULTS;
      const hits: string[] = [];
      for (const e of recent(byProject(entries))) {
        if (!existsSync(e.sessionFile)) continue;
        const lines = flatten(e.sessionFile, 200_000).split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(q)) {
            const ctx = lines.slice(Math.max(0, i - 1), i + 2).join(" ⏎ ");
            hits.push(`[${shortId(e.id)} · ${projectName(e.project)}] …${ctx.slice(0, 300)}…`);
            if (hits.length >= cap) break;
          }
        }
        if (hits.length >= cap) break;
      }
      return hits.length ? `${hits.length} matches de "${input.query}":\n\n${hits.join("\n\n")}` : `Sin matches de "${input.query}".`;
    }

    if (input.action === "read") {
      if (!input.id) return "Falta 'id'.";
      const e = entries.find((x) => x.id === input.id || shortId(x.id) === input.id);
      if (!e) return `No encontré la sesión "${input.id}".`;
      if (!existsSync(e.sessionFile)) return `El transcript de "${input.id}" no está en disco.`;
      return `Sesión ${shortId(e.id)} · ${projectName(e.project)} · "${e.title}"\n\n${flatten(e.sessionFile, input.maxChars ?? MAX_READ_CHARS)}`;
    }

    return `Acción desconocida: "${input.action}". Usá list | search | read.`;
  }
}
