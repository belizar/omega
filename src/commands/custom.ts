import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

/**
 * Un slash command definido por el usuario en un archivo `.md`, no compilado en
 * el binario. El filename es el nombre (`deploy.md` → `/deploy`) y el body es un
 * template de prompt: cuando lo invocás, se expande (sustituyendo $ARGUMENTS /
 * $1..$9) y se manda al modelo como un mensaje de usuario normal. Es el gemelo
 * humano-disparado de las skills (que las dispara el modelo).
 *
 * Viven en dos lugares, igual que el resto de la config de Omega:
 *   .omega/commands/*.md   (proyecto, versionable, gana en caso de conflicto)
 *   ~/.omega/commands/*.md (global, tus comandos personales en cualquier repo)
 */
export interface CustomCommand {
  /** Nombre con la barra, ej: "/deploy". */
  name: string;
  /** Una línea para /help y la lista de comandos. */
  description: string;
  /** Pista de argumentos para mostrar, ej: "<entorno>". Opcional. */
  argumentHint?: string;
  /** El template del prompt (el body del .md, sin el frontmatter). */
  body: string;
  /** De dónde salió: proyecto pisa a global. */
  source: "project" | "global";
}

interface Frontmatter {
  description?: string;
  argumentHint?: string;
}

/**
 * Parser de frontmatter mínimo (sin dependencia de YAML): si el archivo abre con
 * `---`, lee pares `clave: valor` hasta el `---` de cierre. Suficiente para los
 * pocos campos escalares que soportamos; el resto del archivo es el body.
 */
function parseFrontmatter(raw: string): { fm: Frontmatter; body: string } {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { fm: {}, body: raw };
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: raw };

  const block = raw.slice(raw.indexOf("\n") + 1, end);
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1);

  const fm: Frontmatter = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim().replace(/^["']|["']$/g, "");
    if (key === "description") fm.description = value;
    else if (key === "argument-hint" || key === "argumentHint") fm.argumentHint = value;
  }
  return { fm, body };
}

/** Lee un dir de comandos (si existe) y devuelve los que pudo parsear. */
function loadFromDir(dir: string, source: CustomCommand["source"]): CustomCommand[] {
  if (!existsSync(dir)) return [];
  const out: CustomCommand[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const name = basename(file, ".md");
    if (!name) continue;
    let raw: string;
    try {
      raw = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    const { fm, body } = parseFrontmatter(raw);
    out.push({
      name: `/${name}`,
      description: fm.description ?? `Custom command (${source})`,
      argumentHint: fm.argumentHint,
      body: body.trim(),
      source,
    });
  }
  return out;
}

/**
 * Carga los comandos custom de proyecto y global, con proyecto pisando a global
 * cuando hay choque de nombre. Devuelve un mapa por nombre ("/deploy" → cmd)
 * listo para el lookup en dispatchCommand.
 */
export function loadCustomCommands(
  cwd: string = process.cwd(),
  home: string = homedir(),
): Record<string, CustomCommand> {
  const map: Record<string, CustomCommand> = {};
  // Global primero, proyecto después → proyecto sobrescribe.
  for (const cmd of loadFromDir(join(home, ".omega", "commands"), "global")) {
    map[cmd.name] = cmd;
  }
  for (const cmd of loadFromDir(join(cwd, ".omega", "commands"), "project")) {
    map[cmd.name] = cmd;
  }
  return map;
}

/**
 * Expande el template de un comando con los args tipeados:
 *   $ARGUMENTS → todos los args unidos por espacio
 *   $1..$9     → argumento posicional (vacío si falta)
 * Cualquier otro `$` queda intacto.
 */
export function expandCommand(cmd: CustomCommand, args: string[]): string {
  return cmd.body
    .replace(/\$ARGUMENTS\b/g, args.join(" "))
    .replace(/\$([1-9])\b/g, (_m, d: string) => args[Number(d) - 1] ?? "");
}
