import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { DiffResult } from "./diff.js";
import { ReviewContent, ReviewGuide } from "./review.js";

const execFileAsync = promisify(execFile);

/** Dónde viven las reviews de un workspace (per-worktree, como los transcripts). */
const REVIEWS_SUBDIR = ".omega/reviews";

/**
 * Fingerprint ESTABLE de un diff: hash de su contenido (base + archivos + parches),
 * NO del commit. Consecuencia clave: commitear/pushear los mismos cambios da el
 * mismo fingerprint → la review sigue vigente. Es la identidad de una review.
 */
export function fingerprintDiff(diff: DiffResult): string {
  const parts = [
    `base:${diff.base ?? ""}`,
    // por archivo, ordenado: así el orden de listado no cambia el hash.
    ...diff.files
      .map((f) => [f.status, f.oldPath ?? "", f.path, f.additions, f.deletions, f.patch].join("\t"))
      .sort(),
  ];
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

/** El commit actual del workspace (para display). null si no es repo / sin commits. */
export async function gitHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Arma la review persistible: el contenido del LLM + su identidad y metadata. */
export function assembleReview(
  content: ReviewContent,
  meta: { base: string | null; headSha: string | null; fingerprint: string; lens: string; createdAt: number },
): ReviewGuide {
  return { ...content, ...meta };
}

/** La key de archivo: fingerprint + lente → regenerar la MISMA review (mismo diff,
 *  misma lente) la sobrescribe, no la duplica; cambiar el diff o la lente crea otra. */
function reviewKey(fingerprint: string, lens: string): string {
  const lensPart = lens ? createHash("sha256").update(lens).digest("hex").slice(0, 8) : "general";
  return `${fingerprint}__${lensPart}`;
}

/** Guarda una review en `<cwd>/.omega/reviews/<key>.json`. */
export function saveReview(cwd: string, review: ReviewGuide): void {
  const dir = join(cwd, REVIEWS_SUBDIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${reviewKey(review.fingerprint, review.lens)}.json`);
  writeFileSync(file, JSON.stringify(review, null, 2), "utf8");
}

/** Lista las reviews guardadas de un workspace, las más nuevas primero. */
export function listReviews(cwd: string): ReviewGuide[] {
  const dir = join(cwd, REVIEWS_SUBDIR);
  if (!existsSync(dir)) return [];
  const out: ReviewGuide[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, f), "utf8")) as ReviewGuide;
      if (Array.isArray(r?.steps)) out.push(r);
    } catch {
      /* archivo corrupto: lo salteamos */
    }
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
