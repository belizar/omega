import { existsSync, readFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { resolveGitRoot } from "./project.js";

// ── Resolución de paths ────────────────────────────────────────────────

// resolveGitRoot vive en project.ts (fuente única de "qué es el proyecto",
// compartida con la telemetría). Se re-exporta para no romper imports.
export { resolveGitRoot };

/** Devuelve el path del cabinet de proyecto, resuelto al repo real
 *  (no al worktree). null si el repo no tiene cabinet. */
export function resolveProjectCabinet(cwd: string): string | null {
  const gitRoot = resolveGitRoot(cwd);
  if (!gitRoot) return null;
  const cabinet = join(gitRoot, ".omega", "cabinet");
  if (existsSync(cabinet) && statSync(cabinet).isDirectory()) {
    return cabinet;
  }
  return null;
}

/** Path del cabinet global. */
export function getGlobalCabinet(): string {
  return join(homedir(), ".omega", "cabinet");
}

// ── Lectura del INDEX ──────────────────────────────────────────────────

/** Lee el INDEX.md de un cabinet, o null si no existe. */
export function readCabinetIndex(cabinetPath: string): string | null {
  const indexPath = join(cabinetPath, "INDEX.md");
  if (!existsSync(indexPath)) return null;
  try {
    return readFileSync(indexPath, "utf-8").trim();
  } catch {
    return null;
  }
}

// ── Inicialización ─────────────────────────────────────────────────────

const INDEX_TEMPLATE = `# Cabinet

> Memoria de largo plazo de omega. Leé AGENTS.md para las convenciones.

`;

const AGENTS_TEMPLATE = `# Convenciones del cabinet

## Taxonomía

Las carpetas emergen del uso. No las pre-diseñes. Cuando un patrón aparezca
varias veces, creá la carpeta. Arrancá con docs sueltos.

## INDEX.md

Es el catálogo fino. Se carga eager (siempre). Cada entrada es una línea:

\`\`\`
- [título](path/relativo.md) — una línea de resumen · status: active|stale|archived
\`\`\`

No pongas contenido en el INDEX. Solo punteros.

## Ciclo de vida de un doc

\`active\` → \`stale\` → \`archived\` (nunca se borra, se mueve a archive/).

## Compuerta

Regla: **alto costo de re-derivar × vida media larga = consolidá.**

- Sí: decisiones y su *por qué*, hallazgos de investigación, gotchas no obvios,
  modelos mentales de cómo funciona un sistema.
- No: cosas que grep recupera al toque, estado efímero, nada que el código/tests
  ya encoden.
- **Anti-patrón:** nunca snapshotear algo con fuente de verdad viva.
  El código es la verdad de "qué hace el código".
  El cabinet es para lo que el código NO captura.

## Git

Cada consolidación es un commit. El mensaje describe qué se aprendió, no qué
archivos se tocaron. Incluir el id de sesión en el cuerpo del commit para
trazabilidad.
`;

/** Crea la estructura inicial del cabinet si no existe. */
export function initCabinet(path: string): void {
  mkdirSync(path, { recursive: true });

  const indexPath = join(path, "INDEX.md");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, INDEX_TEMPLATE);
  }

  const agentsPath = join(path, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, AGENTS_TEMPLATE);
  }
}

// ── Info ────────────────────────────────────────────────────────────────

/** Cuenta los docs markdown en el cabinet (excluyendo INDEX.md y AGENTS.md). */
export function countCabinetDocs(cabinetPath: string): number {
  let count = 0;
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        walk(join(dir, entry.name));
      } else if (entry.name.endsWith(".md") && entry.name !== "INDEX.md" && entry.name !== "AGENTS.md") {
        count++;
      }
    }
  };
  walk(cabinetPath);
  return count;
}

/** Devuelve true si el cabinet es un repo git con remote configurado. */
export function cabinetHasRemote(cabinetPath: string): boolean {
  const gitConfig = join(cabinetPath, ".git", "config");
  if (!existsSync(gitConfig)) return false;
  try {
    const content = readFileSync(gitConfig, "utf-8");
    return /\[remote\s/.test(content);
  } catch {
    return false;
  }
}

/** Devuelve true si el cabinet ya es un repo git. */
export function cabinetIsGitRepo(cabinetPath: string): boolean {
  return existsSync(join(cabinetPath, ".git"));
}

// ── Construcción del contexto para el system prompt ────────────────────

/** Genera el bloque de contexto del cabinet para inyectar en el system prompt.
 *  Incluye la ubicación, el INDEX (resumido si es largo), y las reglas de compuerta. */
export function buildCabinetContext(): string {
  const parts: string[] = [];

  const projectCabinet = resolveProjectCabinet(process.cwd());
  const globalCabinet = getGlobalCabinet();

  parts.push("\n\n## Memoria de largo plazo (cabinet)");
  parts.push("Omega tiene un cabinet de memoria en disco para conocimiento que trasciende sesiones.");

  if (projectCabinet) {
    const docCount = countCabinetDocs(projectCabinet);
    const hasRemote = cabinetHasRemote(projectCabinet);
    parts.push(`\n**Cabinet del proyecto:** \`${projectCabinet}\` (${docCount} docs)${hasRemote ? " · remote ✓" : ""}`);
    const index = readCabinetIndex(projectCabinet);
    if (index) {
      // Si el INDEX es largo (> 2000 chars), mostrar solo las primeras 50 líneas
      const lines = index.split("\n");
      const truncated = lines.length > 50
        ? lines.slice(0, 50).join("\n") + `\n\n_(INDEX truncado, ${lines.length} líneas totales — leé el resto con read si necesitás)_`
        : index;
      parts.push(`\n**INDEX:**\n\n${truncated}`);
    }
  } else {
    parts.push(`\n**No hay cabinet de proyecto.** Creá uno con \`/cabinet init\` (el usuario puede hacerlo).`);
  }

  // Cabinet global
  const globalExists = existsSync(globalCabinet);
  if (globalExists) {
    const docCount = countCabinetDocs(globalCabinet);
    const hasRemote = cabinetHasRemote(globalCabinet);
    parts.push(`\n**Cabinet global:** \`${globalCabinet}\` (${docCount} docs)${hasRemote ? " · remote ✓" : ""}`);
    const globalIndex = readCabinetIndex(globalCabinet);
    if (globalIndex) {
      const lines = globalIndex.split("\n");
      const truncated = lines.length > 30
        ? lines.slice(0, 30).join("\n") + `\n\n_(truncado)_`
        : globalIndex;
      parts.push(`\n**INDEX global:**\n\n${truncated}`);
    }
  } else {
    parts.push(`\n**Cabinet global:** \`${globalCabinet}\` (no existe aún).`);
  }

  // Reglas de compuerta (siempre presentes, haya o no cabinet)
  parts.push(`\n### Reglas de consolidación (compuerta)`);
  parts.push(`Después de completar una tarea no trivial, evaluá en silencio:`);
  parts.push(`- ¿Descubrí algo que sería **costoso de re-derivar** y tiene **vida media larga**?`);
  parts.push(`- Si sí, y hay un cabinet (proyecto o global), consolidalo:`);
  parts.push(`  1. Escribí un doc markdown conciso en la carpeta adecuada (o creala si el patrón emerge).`);
  parts.push(`  2. Registrá el doc en INDEX.md con título + resumen de una línea + status.`);
  parts.push(`  3. Hacé commit git con mensaje que describa qué aprendiste e incluya el id de sesión.`);
  parts.push(`- Sé **conservador**: en duda, no consolidar. Un cabinet chico y verdadero > uno grande y ruidoso.`);
  parts.push(`- **Nunca** snapshotear cosas con fuente de verdad viva (el código ya las captura).`);
  parts.push(`- El cabinet es para el *por qué*, no el *qué*.`);
  parts.push(`\nSi el usuario dice "/remember <algo>", eso es una señal de que considera ese algo memorable.`);
  parts.push(`Pesalo más alto en tu evaluación de compuerta, pero no consolidés automáticamente:`);
  parts.push(`seguí aplicando criterio. No todo lo memorable merece un doc.`);

  return parts.join("\n");
}
