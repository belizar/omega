import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

/**
 * Una skill: una guía con instrucciones detalladas para una tarea o capacidad
 * concreta, que el *modelo* carga solo cuando le hace falta (a diferencia de un
 * slash command, que lo dispara el humano). Es progressive disclosure: al
 * system prompt solo entra `name` + `description` (barato); el body completo se
 * carga on-demand cuando el agente llama la tool `skill`.
 *
 * Viven en directorios, igual que en Claude Code:
 *   .omega/skills/<name>/SKILL.md   (proyecto, versionable, gana en conflicto)
 *   ~/.omega/skills/<name>/SKILL.md (global, tuyas en cualquier repo)
 *
 * El directorio puede traer archivos extra (scripts, plantillas) que el body
 * referencia; por eso guardamos `dir` y se lo pasamos al modelo para que los lea.
 */
export interface Skill {
  /** Identificador que el modelo pasa a la tool `skill`. */
  name: string;
  /** Una línea — lo único, junto al name, que entra al system prompt. */
  description: string;
  /** El cuerpo del SKILL.md (instrucciones), sin el frontmatter. */
  body: string;
  /** Path absoluto del directorio de la skill (para archivos bundled). */
  dir: string;
  /** Proyecto pisa a global. */
  source: "project" | "global";
}

/**
 * Frontmatter mínimo sin dep de YAML: pares `clave: valor` entre `---`. Devuelve
 * el mapa de claves y el body restante.
 */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { fm: {}, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: raw };

  const block = raw.slice(raw.indexOf("\n") + 1, end);
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1);

  const fm: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fm, body };
}

/** Lee un dir de skills (si existe). Cada subdir con un SKILL.md es una skill. */
function loadFromDir(dir: string, source: Skill["source"]): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(dir)) {
    const skillDir = join(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(skillDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const mdPath = join(skillDir, "SKILL.md");
    if (!existsSync(mdPath)) continue;

    let raw: string;
    try {
      raw = readFileSync(mdPath, "utf8");
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    const name = fm.name || basename(skillDir);
    if (!name) continue;
    // Sin descripción no hay disclosure útil (el modelo no sabría cuándo usarla).
    const description = fm.description || `Skill ${name} (sin descripción)`;
    out.push({ name, description, body: body.trim(), dir: skillDir, source });
  }
  return out;
}

/**
 * Carga las skills de global y proyecto, con proyecto pisando a global cuando
 * hay choque de `name`. Devuelve la lista lista para el system prompt + la tool.
 */
export function loadSkills(
  cwd: string = process.cwd(),
  home: string = homedir(),
): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of loadFromDir(join(home, ".omega", "skills"), "global")) {
    byName.set(s.name, s);
  }
  for (const s of loadFromDir(join(cwd, ".omega", "skills"), "project")) {
    byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
