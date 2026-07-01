import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";

const { join } = path;

// ── Tipos ────────────────────────────────────────────────────────────────────

/** Datos mínimos de una sesión persistidos en telemetría global. */
export interface TelemetryRecord {
  id: string;
  /** Nombre de la sesión (puede estar vacío). */
  name: string;
  /** Timestamp ISO del último guardado. */
  savedAt: string;
  /** Costo acumulado en USD. */
  totalCost: number;
  /** Tokens acumulados. */
  totalTokens: { input: number; output: number };
  /** Modelo usado (puede estar vacío). */
  model: string;
  /** CWD desde donde corrió la sesión (para inferir proyecto). */
  cwd: string;
}

export interface ProjectSummary {
  /** Slug del proyecto (último segmento del git root o carpeta). */
  project: string;
  /** Ruta absoluta del directorio raíz detectado. */
  root: string;
  /** Cantidad de sesiones registradas. */
  sessionCount: number;
  /** Costo total en USD. */
  totalCost: number;
  /** Tokens acumulados. */
  totalTokens: { input: number; output: number };
  /** Sesiones ordenadas por fecha descendente. */
  sessions: TelemetryRecord[];
}

export interface GlobalSummary {
  /** Costo total de todas las sesiones de todos los proyectos. */
  totalCost: number;
  /** Tokens acumulados totales. */
  totalTokens: { input: number; output: number };
  /** Cantidad total de sesiones. */
  sessionCount: number;
  /** Proyectos ordenados por costo descendente. */
  projects: { project: string; root: string; sessionCount: number; totalCost: number }[];
}

// ── Paths ────────────────────────────────────────────────────────────────────

const TELEMETRY_DIR = join(homedir(), ".omega", "telemetry");

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Infiere el "slug" de proyecto desde un CWD.
 * Busca el git root hacia arriba; si no hay, usa el basename del CWD.
 */
export function inferProjectSlug(cwd: string): { slug: string; root: string } {
  let dir = path.resolve(cwd);
  // Buscar git root subiendo
  while (true) {
    const gitDir = join(dir, ".git");
    if (existsSync(gitDir)) return { slug: path.basename(dir), root: dir };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: usar el basename del CWD
  const resolved = path.resolve(cwd);
  return { slug: path.basename(resolved), root: resolved };
}

// ── API ──────────────────────────────────────────────────────────────────────

/**
 * Graba un registro de telemetría para una sesión.
 * Crea/sobrescribe `~/.omega/telemetry/<projectSlug>/<id>.json`.
 */
export function record(entry: TelemetryRecord): void {
  const { slug } = inferProjectSlug(entry.cwd);
  const projectDir = join(TELEMETRY_DIR, slug);
  ensureDir(projectDir);

  // Merge con datos existentes si los hay (por si la sesión ya tenía registro previo)
  const filePath = join(projectDir, `${entry.id}.json`);
  let merged: TelemetryRecord = { ...entry };
  if (existsSync(filePath)) {
    try {
      const existing = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<TelemetryRecord>;
      // El nuevo registro pisa costos y tokens (que son acumulativos), pero preserva fechas viejas
      merged = { ...existing, ...entry, savedAt: entry.savedAt };
    } catch {
      // Si el archivo está corrupto, sobrescribimos
    }
  }

  writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * Lista todos los proyectos con telemetría.
 * Cada proyecto tiene su summary (costos, sesiones, etc.).
 */
export function listProjects(): ProjectSummary[] {
  if (!existsSync(TELEMETRY_DIR)) return [];

  const projects: ProjectSummary[] = [];
  for (const slug of readdirSync(TELEMETRY_DIR)) {
    const projectDir = join(TELEMETRY_DIR, slug);
    if (!existsSync(projectDir)) continue;
    const stat = require("fs").statSync(projectDir);
    if (!stat.isDirectory()) continue;

    const sessions: TelemetryRecord[] = [];
    for (const file of readdirSync(projectDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(projectDir, file), "utf-8")) as TelemetryRecord;
        sessions.push(data);
      } catch {
        // Ignorar archivos corruptos
      }
    }

    sessions.sort((a, b) => b.savedAt.localeCompare(a.savedAt));

    const totalCost = sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
    const totalTokens = sessions.reduce(
      (acc, s) => {
        acc.input += s.totalTokens?.input || 0;
        acc.output += s.totalTokens?.output || 0;
        return acc;
      },
      { input: 0, output: 0 },
    );

    projects.push({
      project: slug,
      root: sessions[0]?.cwd ?? "",
      sessionCount: sessions.length,
      totalCost,
      totalTokens,
      sessions,
    });
  }

  // Ordenar por costo descendente
  projects.sort((a, b) => b.totalCost - a.totalCost);
  return projects;
}

/**
 * Devuelve el detalle de un proyecto específico por slug.
 */
export function getProject(slug: string): ProjectSummary | null {
  const projectDir = join(TELEMETRY_DIR, slug);
  if (!existsSync(projectDir)) return null;

  const sessions: TelemetryRecord[] = [];
  for (const file of readdirSync(projectDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      sessions.push(JSON.parse(readFileSync(join(projectDir, file), "utf-8")) as TelemetryRecord);
    } catch {
      // Ignorar archivos corruptos
    }
  }

  sessions.sort((a, b) => b.savedAt.localeCompare(a.savedAt));

  const totalCost = sessions.reduce((sum, s) => sum + (s.totalCost || 0), 0);
  const totalTokens = sessions.reduce(
    (acc, s) => {
      acc.input += s.totalTokens?.input || 0;
      acc.output += s.totalTokens?.output || 0;
      return acc;
    },
    { input: 0, output: 0 },
  );

  return {
    project: slug,
    root: sessions[0]?.cwd ?? "",
    sessionCount: sessions.length,
    totalCost,
    totalTokens,
    sessions,
  };
}

/**
 * Devuelve un resumen global de toda la telemetría.
 */
export function getGlobalSummary(): GlobalSummary {
  const projects = listProjects();

  const totalCost = projects.reduce((sum, p) => sum + p.totalCost, 0);
  const totalTokens = projects.reduce(
    (acc, p) => {
      acc.input += p.totalTokens.input;
      acc.output += p.totalTokens.output;
      return acc;
    },
    { input: 0, output: 0 },
  );
  const sessionCount = projects.reduce((sum, p) => sum + p.sessionCount, 0);

  return {
    totalCost,
    totalTokens,
    sessionCount,
    projects: projects.map(p => ({
      project: p.project,
      root: p.root,
      sessionCount: p.sessionCount,
      totalCost: p.totalCost,
    })),
  };
}

/**
 * Borra todos los registros de un proyecto (útil si se elimina el proyecto).
 */
export function deleteProject(slug: string): boolean {
  const projectDir = join(TELEMETRY_DIR, slug);
  if (!existsSync(projectDir)) return false;
  try {
    const { rmSync } = require("fs");
    rmSync(projectDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}