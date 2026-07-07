#!/usr/bin/env node
// Compara dos corridas del interviewer (el A/B). Lee dos CSVs y muestra, por
// question, éxito / timeouts / mediana de pasos / mediana de tok-out para cada
// lado, con el delta. La señal de "¿el cambio de harness mejoró?" vive acá.
//
// Uso:
//   node interview/compare.mjs antes despues            # busca el último CSV de cada label
//   node interview/compare.mjs a.csv b.csv              # o dos paths directos

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");

/** Resuelve un arg a un path de CSV: si es un archivo, lo usa; si es un label,
 *  busca el CSV más reciente `run-<label>-*.csv` en results/. */
function resolveCsv(arg) {
  if (existsSync(arg) && arg.endsWith(".csv")) return resolve(arg);
  const matches = readdirSync(RESULTS)
    .filter((f) => f.startsWith(`run-${arg}-`) && f.endsWith(".csv"))
    .sort();
  if (matches.length === 0) throw new Error(`no encuentro un CSV para "${arg}"`);
  return join(RESULTS, matches[matches.length - 1]);
}

function parseCsv(path) {
  const [header, ...lines] = readFileSync(path, "utf-8").trim().split("\n");
  const cols = header.split(",");
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

function median(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Agrega un CSV por question: pass-rate, timeouts, medianas entre los que pasaron. */
function summarize(rows) {
  const byQ = new Map();
  for (const r of rows) {
    if (!byQ.has(r.question)) byQ.set(r.question, []);
    byQ.get(r.question).push(r);
  }
  const out = new Map();
  for (const [q, rs] of byQ) {
    const passes = rs.filter((r) => r.verdict === "pass");
    const timeouts = rs.filter((r) => r.verdict === "timeout").length;
    out.set(q, {
      n: rs.length,
      pass: passes.length,
      timeouts,
      medSteps: median(passes.map((r) => Number(r.steps))),
      medTokOut: median(passes.map((r) => Number(r.tokensOut))),
    });
  }
  return out;
}

function delta(a, b) {
  if (a == null || b == null) return "";
  const d = b - a;
  if (d === 0) return "=";
  const arrow = d < 0 ? "▼" : "▲";
  return `${arrow}${Math.abs(d)}`;
}

const [argA, argB] = process.argv.slice(2);
if (!argA || !argB) {
  console.error("uso: node interview/compare.mjs <antes> <despues>  (labels o paths .csv)");
  process.exit(2);
}

const A = summarize(parseCsv(resolveCsv(argA)));
const B = summarize(parseCsv(resolveCsv(argB)));

console.log(`\nA/B  ·  A=${argA}  vs  B=${argB}\n`);
console.log("question         éxito A→B      timeouts A→B   med.steps A→B      med.tokOut A→B");
for (const q of new Set([...A.keys(), ...B.keys()])) {
  const a = A.get(q) ?? {};
  const b = B.get(q) ?? {};
  console.log(
    [
      q.padEnd(16),
      `${a.pass ?? "—"}/${a.n ?? "—"} → ${b.pass ?? "—"}/${b.n ?? "—"}`.padEnd(14),
      `${a.timeouts ?? "—"} → ${b.timeouts ?? "—"}`.padEnd(15),
      `${a.medSteps ?? "—"} → ${b.medSteps ?? "—"} ${delta(a.medSteps, b.medSteps)}`.padEnd(19),
      `${a.medTokOut ?? "—"} → ${b.medTokOut ?? "—"} ${delta(a.medTokOut, b.medTokOut)}`,
    ].join(" "),
  );
}
console.log("\n(▼ = bajó = mejor para esfuerzo. Ojo con el éxito: no lo cambies por eficiencia.)");
