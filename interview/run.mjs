#!/usr/bin/env node
// Omega Interviews — el interviewer.
//
// Evals agénticos con marco de entrevista: cada `candidate` (modelo) responde
// cada `question` (tarea) en varios `rounds` (repeticiones), y una `rubric`
// objetiva emite el `verdict` (pass/fail). Registramos la trayectoria (costo,
// pasos, tokens) y agregamos por (question, candidate) en tasa de éxito + medianas.
//
// Por (question × candidate × round):
//   1. reset: copiar el repo de la question a un workdir temporal fresco.
//   2. correr omega headless con ese candidate sobre el brief.
//   3. correr la rubric contra el workdir → verdict.
//   4. registrar la fila (verdict + métricas del transcript).
// Con budget cap: para antes de pasarse del gasto.
//
// Uso:
//   node interview/run.mjs --models deepseek/deepseek-v4-pro --k 1 --budget 0.50
//   node interview/run.mjs --models a,b --k 3 --question demo-bugfix --budget 2

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const OMEGA = resolve(REPO_ROOT, "dist", "index.js");
const QUESTIONS_DIR = join(HERE, "questions");

// ── args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { models: [], k: 1, budget: 1.0, question: null, omega: OMEGA, label: null, timeout: 300, temp: null, sandbox: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--models") a.models = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--k" || arg === "--rounds") a.k = parseInt(argv[++i], 10);
    else if (arg === "--budget") a.budget = parseFloat(argv[++i]);
    else if (arg === "--question") a.question = argv[++i];
    else if (arg === "--omega") a.omega = resolve(argv[++i]);
    // Etiqueta de la corrida, para el A/B (ej. --label antes / --label despues).
    else if (arg === "--label") a.label = argv[++i];
    // Timeout por corrida en segundos (default 300): mata un omega colgado.
    else if (arg === "--timeout") a.timeout = parseInt(argv[++i], 10);
    // Temperatura de sampling que se le pasa a omega (ej. --temp 0). Baja la
    // varianza corrida-a-corrida. Sin flag → omega usa el default del proveedor.
    else if (arg === "--temp") a.temp = argv[++i];
    // Sandbox: corre el bash del agente en un contenedor Docker (workdir montado).
    else if (arg === "--sandbox") a.sandbox = true;
  }
  return a;
}

// ── carga de questions ──────────────────────────────────────────────────────
function loadQuestions(only) {
  const names = readdirSync(QUESTIONS_DIR).filter((n) =>
    existsSync(join(QUESTIONS_DIR, n, "brief.md")),
  );
  const picked = only ? names.filter((n) => n === only) : names;
  return picked.map((name) => {
    const dir = join(QUESTIONS_DIR, name);
    // Snapshot pristino inmutable: se copia el repo UNA vez, ahora (source limpio),
    // a un temp. Cada corrida copia desde acá, NO del source vivo. Así, aunque el
    // bash de un agente que thrashea corrompa el source del worktree, los datos
    // de las corridas nunca se contaminan. (El aislamiento real del agente —que no
    // pueda tocar el worktree— es un contenedor; esto blinda los datos mientras.)
    const pristine = mkdtempSync(join(tmpdir(), `pristine-${name}-`));
    cpSync(join(dir, "repo"), pristine, { recursive: true });
    return {
      name,
      dir,
      brief: readFileSync(join(dir, "brief.md"), "utf-8").trim(),
      repoDir: join(dir, "repo"),
      pristine,
      rubric: join(dir, "rubric.mjs"),
    };
  });
}

// ── una entrevista (question × candidate × round) → fila ────────────────────
function interview(question, candidate, round, omegaEntry, timeoutSec, temp, sandbox) {
  // 1. reset: workdir fresco con una copia del snapshot PRISTINO (no del source
  // vivo — así una corrida previa que corrompió el source no contamina ésta).
  const workdir = mkdtempSync(join(tmpdir(), `interview-${question.name}-`));
  cpSync(question.pristine, workdir, { recursive: true });

  // 2. correr omega headless con este candidate sobre el brief.
  // timeout: un candidate que se cuelga o thrashea sin fin no puede colgar todo
  // el harness — lo matamos y la corrida cuenta como fallo (del harness, no del
  // candidate: no llegó a un veredicto).
  // sandbox: OMEGA_SANDBOX=1 → el bash del agente corre en un contenedor con el
  // workdir montado (no puede escapar al filesystem del host).
  const args = [omegaEntry, "-p", question.brief, "--model", candidate, "--format", "json"];
  if (temp != null) args.push("--temp", String(temp));
  const proc = spawnSync("node", args, {
    cwd: workdir,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutSec * 1000,
    env: sandbox ? { ...process.env, OMEGA_SANDBOX: "1" } : process.env,
  });

  const timedOut = proc.error?.code === "ETIMEDOUT";
  const result = parseResult(proc.stdout);

  // 3. rubric → verdict (objetivo, no a ojo). Un timeout NO es pass, aunque el
  // código en disco haya quedado correcto: el candidate no convergió (nunca
  // "terminó"). Es su propio verdict, fuera del pass-rate.
  const check = spawnSync("node", [question.rubric, workdir], { encoding: "utf-8" });
  const verdict = timedOut ? "timeout" : check.status === 0 ? "pass" : "fail";

  // 4. limpiar el workdir (el estado sucio de una corrida contamina la siguiente).
  rmSync(workdir, { recursive: true, force: true });

  const m = result?.metrics ?? {};
  return {
    question: question.name,
    candidate,
    round,
    verdict,
    cost: m.cost ?? 0,
    steps: m.steps ?? null,
    // Señal de harness: re-lecturas (thrashing de navegación) y tool-errors.
    // Con el modelo congelado, acá es donde se ve si omega trabaja mejor o peor.
    rereads: m.rereads?.length ?? 0,
    toolErrors: m.toolErrors ?? 0,
    tokensIn: m.inputTokens ?? null,
    tokensOut: m.outputTokens ?? null,
    durationMs: m.durationMs ?? null,
    // razón de fallo del harness (no del candidate) — timeout u omega crasheó.
    error: result
      ? null
      : timedOut
        ? `timeout tras ${timeoutSec}s`
        : (proc.stderr || "sin línea result").slice(0, 200),
  };
}

/** Extrae la línea `result` del NDJSON de omega (ignora el resto de eventos). */
function parseResult(stdout) {
  for (const line of (stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === "result") return o;
    } catch {
      /* línea no-JSON: ignorar */
    }
  }
  return null;
}

/** Concatena los .mjs de un dir (para comparar source vs pristino). */
function repoFingerprint(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .sort()
    .map((f) => `${f}\n${readFileSync(join(dir, f), "utf-8")}`)
    .join("\n");
}

/** Avisa si algún agente tocó el source del worktree durante las corridas (el
 *  bash del agente puede escapar del temp). Los DATOS están blindados por el
 *  snapshot pristino; esto es para enterarnos del leak. */
function checkSourceIntegrity(questions) {
  const dirty = questions.filter(
    (q) => repoFingerprint(q.repoDir) !== repoFingerprint(q.pristine),
  );
  if (dirty.length > 0) {
    console.log(
      `\n⚠ Un agente tocó el SOURCE de: ${dirty.map((q) => q.name).join(", ")}. ` +
        `Los datos están OK (se corrió desde el snapshot pristino), pero restaurá el ` +
        `worktree (git checkout interview/questions/). Fix real: correr el agente en contenedor.`,
    );
  }
}

// ── agregación ──────────────────────────────────────────────────────────────
function median(xs) {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function aggregate(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.question} ${r.candidate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [key, rs] of groups) {
    const [question, candidate] = key.split(" ");
    const passes = rs.filter((r) => r.verdict === "pass");
    out.push({
      question,
      candidate,
      passRate: `${passes.length}/${rs.length}`,
      // Todo SOLO entre los que pasaron (el eje cero es correctitud). Con el
      // modelo congelado, med.rereads/errors es la señal de calidad del harness.
      medCost: median(passes.map((r) => r.cost)),
      medSteps: median(passes.map((r) => r.steps)),
      medRereads: median(passes.map((r) => r.rereads)),
      medErrors: median(passes.map((r) => r.toolErrors)),
    });
  }
  return out;
}

// ── salida ───────────────────────────────────────────────────────────────────
function fmtCost(c) {
  if (c == null) return "—";
  return c < 0.01 ? "<$0.01" : `$${c.toFixed(4)}`;
}

function printRows(rows) {
  console.log("\n── Transcripts (una fila por corrida) ──");
  console.log("question         candidate                  round  verdict  steps  reread  errs  cost      tok(in/out)");
  for (const r of rows) {
    const v = r.verdict === "pass" ? "✓ pass" : r.verdict === "timeout" ? "⏱ t/o" : "✗ fail";
    console.log(
      [
        r.question.padEnd(16),
        r.candidate.padEnd(26),
        String(r.round).padEnd(6),
        v.padEnd(8),
        String(r.steps ?? "—").padEnd(6),
        String(r.rereads).padEnd(7),
        String(r.toolErrors).padEnd(5),
        fmtCost(r.cost).padEnd(9),
        `${r.tokensIn ?? "—"}/${r.tokensOut ?? "—"}`,
      ].join(" "),
    );
    if (r.error) console.log(`    ⚠ ${r.error}`);
  }
}

function printAggregate(agg) {
  console.log("\n── Veredicto por (question, candidate) — medianas entre los que pasaron ──");
  console.log("question         candidate                  éxito   med.cost   med.steps  med.reread  med.errs");
  for (const a of agg) {
    console.log(
      [
        a.question.padEnd(16),
        a.candidate.padEnd(26),
        a.passRate.padEnd(7),
        fmtCost(a.medCost).padEnd(10),
        String(a.medSteps ?? "—").padEnd(10),
        String(a.medRereads ?? "—").padEnd(11),
        String(a.medErrors ?? "—"),
      ].join(" "),
    );
  }
}

function writeCsv(rows, label) {
  const dir = join(HERE, "results");
  mkdirSync(dir, { recursive: true });
  const tag = label ? `${label}-` : "";
  const file = join(dir, `run-${tag}${Date.now()}.csv`);
  const header = "label,question,candidate,round,verdict,cost,steps,rereads,toolErrors,tokensIn,tokensOut,durationMs";
  const body = rows
    .map((r) =>
      [label ?? "", r.question, r.candidate, r.round, r.verdict, r.cost, r.steps, r.rereads, r.toolErrors, r.tokensIn, r.tokensOut, r.durationMs].join(","),
    )
    .join("\n");
  writeFileSync(file, header + "\n" + body + "\n");
  return file;
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.models.length === 0) {
    console.error("Falta --models <a,b,...>. Ej: node interview/run.mjs --models deepseek/deepseek-v4-pro --k 1 --budget 0.5");
    process.exit(2);
  }
  if (!existsSync(args.omega)) {
    console.error(`No encuentro omega en ${args.omega}. Corré \`npm run build\` primero (o pasá --omega <ruta a dist/index.js>).`);
    process.exit(2);
  }

  const questions = loadQuestions(args.question);
  if (questions.length === 0) {
    console.error(args.question ? `No existe la question "${args.question}".` : "No hay questions en interview/questions/.");
    process.exit(2);
  }

  const planned = questions.length * args.models.length * args.k;
  console.log(`Omega Interviews${args.label ? ` · ${args.label}` : ""}`);
  console.log(`  omega:      ${args.omega}`);
  console.log(`  candidates: ${args.models.join(", ")}`);
  console.log(`  questions:  ${questions.map((q) => q.name).join(", ")}`);
  console.log(`  rounds (k): ${args.k}  →  ${planned} corridas`);
  console.log(`  budget cap: $${args.budget.toFixed(2)} (para antes de pasarse)`);
  console.log(`  timeout:    ${args.timeout}s por corrida`);
  console.log(`  temp:       ${args.temp ?? "(default del proveedor)"}`);
  console.log(`  sandbox:    ${args.sandbox ? "ON (bash del agente en contenedor)" : "off"}`);

  const rows = [];
  let spent = 0;
  let stopped = false;

  outer: for (const question of questions) {
    for (const candidate of args.models) {
      for (let round = 1; round <= args.k; round++) {
        if (spent >= args.budget) {
          console.log(`\n⛔ Budget cap alcanzado ($${spent.toFixed(4)} ≥ $${args.budget.toFixed(2)}). Corto acá.`);
          stopped = true;
          break outer;
        }
        process.stdout.write(`  · ${question.name} / ${candidate} / round ${round} … `);
        const row = interview(question, candidate, round, args.omega, args.timeout, args.temp, args.sandbox);
        rows.push(row);
        spent += row.cost;
        const mark = row.verdict === "pass" ? "✓" : row.verdict === "timeout" ? "⏱" : "✗";
        console.log(`${mark} (${fmtCost(row.cost)}, gastado $${spent.toFixed(4)})`);
      }
    }
  }

  checkSourceIntegrity(questions);
  printRows(rows);
  printAggregate(aggregate(rows));
  const csv = writeCsv(rows, args.label);
  console.log(`\nGasto total: $${spent.toFixed(4)}${stopped ? " (cortado por budget)" : ""}`);
  console.log(`CSV: ${csv}`);
}

main();
