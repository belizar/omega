/**
 * context-growth.ts — Reconstruye y grafica el crecimiento del contexto por
 * step de una sesion de omega.
 *
 * Por que reconstruye en vez de leer datos reales: el provider devuelve el
 * usage real por cada call (input_tokens/output_tokens), pero el runner los
 * suma al toque en sus #metrics y NO los persiste por step. En disco la sesion
 * solo guarda el agregado (totalTokens) + los messages + el workingContext.
 * Asi que para sesiones ya guardadas la unica via es re-simular el loop sobre
 * los mensajes y ESTIMAR los tokens (chars/4). Validado contra totalTokens.input
 * real da ~2% de error, suficiente para entender la FORMA del crecimiento.
 *
 * Uso:
 *   node scripts/context-growth.ts <sessionId | ruta.json | --latest> [flags]
 *
 * Flags:
 *   --latest        usa la sesion modificada mas recientemente
 *   --sys=N         tokens estimados del system prompt (default 1100)
 *   --width=N       ancho del chart en columnas (default 64)
 *   --height=N      alto del chart en filas (default 16)
 *   --csv           imprime CSV (step,raw_tokens,wc_tokens) en vez del chart
 *   --dir=PATH      carpeta de sesiones (default .omega/sessions)
 */

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, isAbsolute } from "path";

type Role = "user" | "assistant";
interface Message {
  role: Role;
  content: unknown;
}
interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
}
interface SessionFile {
  id: string;
  name?: string;
  messages: Message[];
  workingContext?: Message[];
  totalTokens?: { input: number; output: number };
  totalCost?: number;
  /** Uso real por step (si la sesion corrio con el runner instrumentado). */
  stepUsage?: StepUsage[];
}

// ── CLI ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = new Map<string, string>();
let positional: string | undefined;
for (const a of args) {
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=");
    flags.set(k, v ?? "true");
  } else {
    positional = a;
  }
}

const SESSIONS_DIR = flags.get("dir") ?? ".omega/sessions";
const SYS = Number(flags.get("sys") ?? 1100);
const WIDTH = Number(flags.get("width") ?? 64);
const HEIGHT = Number(flags.get("height") ?? 16);
const AS_CSV = flags.has("csv");

// ── estimacion de tokens ─────────────────────────────────────────────────────

/** chars/4 recursivo: suma el largo de TODOS los strings que cuelgan del
 * content, sea string, array de bloques, o dict (text/tool_use.input/
 * tool_result.content). No cuenta sintaxis JSON, solo contenido. */
function estTokens(x: unknown): number {
  if (x == null) return 0;
  if (typeof x === "string") return x.length / 4;
  if (typeof x === "number" || typeof x === "boolean") return String(x).length / 4;
  if (Array.isArray(x)) return x.reduce((s: number, i) => s + estTokens(i), 0);
  if (typeof x === "object") {
    return Object.values(x as Record<string, unknown>).reduce(
      (s, v) => s + estTokens(v),
      0,
    );
  }
  return 0;
}

/** Para cada mensaje de assistant, el contexto enviado en esa call es:
 * system + todos los mensajes ANTERIORES (el prefijo). Devuelve la serie de
 * esos tamanios, uno por step de assistant. */
function perStepSeries(messages: Message[], sys: number): number[] {
  const series: number[] = [];
  let running = sys;
  for (const m of messages) {
    if (m.role === "assistant") series.push(running);
    running += estTokens(m.content);
  }
  return series;
}

// ── resolucion de sesion ─────────────────────────────────────────────────────

function resolveSessionPath(): string {
  if (positional && !flags.has("latest")) {
    if (positional.endsWith(".json") || isAbsolute(positional) || positional.includes("/")) {
      return positional;
    }
    return join(SESSIONS_DIR, `${positional}.json`);
  }
  // --latest (o sin arg): la mas reciente por mtime
  if (!existsSync(SESSIONS_DIR)) {
    fail(`No existe la carpeta de sesiones: ${SESSIONS_DIR}`);
  }
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(SESSIONS_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (files.length === 0) fail(`No hay sesiones en ${SESSIONS_DIR}`);
  return files[0];
}

function fail(msg: string): never {
  console.error(`\x1b[31m${msg}\x1b[0m`);
  process.exit(1);
}

// ── chart ASCII ──────────────────────────────────────────────────────────────

/** Muestrea una serie a `cols` puntos (indices equiespaciados). */
function sample(series: number[], cols: number): number[] {
  if (series.length <= cols) return series.slice();
  const out: number[] = [];
  for (let c = 0; c < cols; c++) {
    const idx = Math.round((c / (cols - 1)) * (series.length - 1));
    out.push(series[idx]);
  }
  return out;
}

function renderChart(
  raw: number[],
  wc: number[],
  width: number,
  height: number,
): string {
  const cols = Math.min(width, raw.length);
  const sRaw = sample(raw, cols);
  const sWc = sample(wc, cols);
  const max = Math.max(...sRaw, ...sWc, 1);

  // grid[row][col]; row 0 = arriba (valor alto)
  const grid: string[][] = Array.from({ length: height }, () =>
    Array.from({ length: cols }, () => " "),
  );
  const rowFor = (v: number) =>
    height - 1 - Math.round((v / max) * (height - 1));

  for (let c = 0; c < cols; c++) {
    const rRaw = rowFor(sRaw[c]);
    const rWc = rowFor(sWc[c]);
    grid[rRaw][c] = grid[rRaw][c] === "#" ? "*" : "."; // raw = punto
    grid[rWc][c] = grid[rWc][c] === "." ? "*" : "#"; // wc = lleno; colision = *
  }

  const kLabel = (v: number) => `${Math.round(v / 1000)}k`.padStart(6);
  const lines: string[] = [];
  for (let r = 0; r < height; r++) {
    // etiqueta Y solo en top / mid / bottom
    let yLabel = "      ";
    if (r === 0) yLabel = kLabel(max);
    else if (r === height - 1) yLabel = kLabel(0);
    else if (r === Math.floor(height / 2)) yLabel = kLabel(max / 2);
    lines.push(`${yLabel} │${grid[r].join("")}`);
  }
  // eje X
  lines.push(`       └${"─".repeat(cols)}`);
  const xMid = `step 1`.padEnd(Math.floor(cols / 2) + 7);
  lines.push(`${xMid}step ${raw.length}`);
  return lines.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────

const path = resolveSessionPath();
if (!existsSync(path)) fail(`No existe el archivo: ${path}`);

let sess: SessionFile;
try {
  sess = JSON.parse(readFileSync(path, "utf-8"));
} catch (e) {
  fail(`No pude parsear ${path}: ${(e as Error).message}`);
}

const messages = sess.messages ?? [];
const working = sess.workingContext ?? messages;

const rawSeries = perStepSeries(messages, SYS);
const wcSeries = perStepSeries(working, SYS);

// Modo REAL: si la sesion corrio con el runner instrumentado, hay datos por
// step de verdad (input/output/cached/cost). Si no, caemos al reconstruido.
const hasReal = Array.isArray(sess.stepUsage) && sess.stepUsage.length > 0;
const real = sess.stepUsage ?? [];

// Series del chart. Real: input total (contexto enviado) vs uncached (input -
// cached) → el gap entre ambas es lo cacheado. Estimado: raw vs workingContext.
const seriesTop = hasReal ? real.map((s) => s.inputTokens) : rawSeries;
const seriesBot = hasReal
  ? real.map((s) => Math.max(0, s.inputTokens - (s.cachedTokens ?? 0)))
  : wcSeries;

if (AS_CSV) {
  if (hasReal) {
    console.log("step,input,output,cached,cost");
    real.forEach((s, i) =>
      console.log(`${i + 1},${s.inputTokens},${s.outputTokens},${s.cachedTokens ?? 0},${s.cost ?? 0}`),
    );
  } else {
    console.log("step,raw_tokens,wc_tokens");
    for (let i = 0; i < rawSeries.length; i++) {
      console.log(`${i + 1},${Math.round(rawSeries[i])},${Math.round(wcSeries[i])}`);
    }
  }
  process.exit(0);
}

const steps = seriesTop.length;
const userTurns = messages.filter(
  (m) => m.role === "user" && typeof m.content === "string",
).length;
const toolResults = messages.filter(
  (m) =>
    m.role === "user" &&
    Array.isArray(m.content) &&
    (m.content as { type?: string }[]).some((b) => b?.type === "tool_result"),
).length;

const m = (n: number) => `${(n / 1e6).toFixed(1)}M`;
const k = (n: number) => `${(n / 1000).toFixed(0)}k`;

console.log("");
console.log(`\x1b[1msesion:\x1b[0m ${sess.name ?? "(sin nombre)"}  \x1b[2m${sess.id}\x1b[0m`);
console.log(
  `\x1b[2msteps:\x1b[0m ${steps}   \x1b[2muser turns:\x1b[0m ${userTurns}   \x1b[2mtool_results:\x1b[0m ${toolResults}   \x1b[2mfuente:\x1b[0m ${hasReal ? "real (instrumentado)" : "estimado (reconstruido)"}`,
);
console.log("");

if (hasReal) {
  const totalIn = real.reduce((a, s) => a + s.inputTokens, 0);
  const totalCached = real.reduce((a, s) => a + (s.cachedTokens ?? 0), 0);
  const totalCost = real.reduce((a, s) => a + (s.cost ?? 0), 0);
  const cachedPct = totalIn > 0 ? ((totalCached / totalIn) * 100).toFixed(0) : "0";
  console.log(`\x1b[1mInput total (real):\x1b[0m ${m(totalIn)} tokens   \x1b[2mcacheado: ${m(totalCached)} (${cachedPct}%)\x1b[0m`);
  console.log(`\x1b[1mCosto real:\x1b[0m $${totalCost.toFixed(2)}`);
  console.log("");
  console.log(`\x1b[1mContexto por step:\x1b[0m  primero ${k(seriesTop[0])} → ultimo ${k(seriesTop[steps - 1])}`);
  console.log("");
  console.log(`  \x1b[2m. = input total (contexto enviado)   # = uncached (pagás full)   * = solapan  ·  gap entre lineas = cacheado\x1b[0m`);
} else {
  const sumRaw = rawSeries.reduce((a, b) => a + b, 0);
  const sumWc = wcSeries.reduce((a, b) => a + b, 0);
  const realInput = sess.totalTokens?.input ?? 0;
  const savedPct = sumRaw > 0 ? ((1 - sumWc / sumRaw) * 100).toFixed(0) : "0";
  const errPct = realInput > 0 ? (((sumWc - realInput) / realInput) * 100).toFixed(1) : "n/a";
  console.log(`\x1b[1mInput acumulado en toda la sesion (lo que se reenvia):\x1b[0m`);
  console.log(`  sin compactar (contrafactual) : ${m(sumRaw)} tokens`);
  console.log(`  workingContext (estimado)     : ${m(sumWc)} tokens   \x1b[2m(compaction ahorro ~${savedPct}%)\x1b[0m`);
  if (realInput > 0)
    console.log(`  totalTokens.input (real)      : ${m(realInput)} tokens   \x1b[2m(error estimacion: ${errPct}%)\x1b[0m`);
  console.log("");
  console.log(`\x1b[1mContexto por step:\x1b[0m  primero ${k(wcSeries[0])} → ultimo ${k(wcSeries[steps - 1])}  (workingContext)`);
  console.log("");
  console.log(`  \x1b[2m. = sin compactar    # = workingContext    * = solapan\x1b[0m`);
}
console.log("");
console.log(renderChart(seriesTop, seriesBot, WIDTH, HEIGHT));
console.log("");
