// Rúbrica de nav-negatives: compute() debe manejar negativos, sin romper positivos.
// Corre contra el workdir del candidate (argv[2]). Exit 0 = pass, 1 = fail.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const workdir = process.argv[2];
if (!workdir) {
  console.error("uso: node rubric.mjs <workdir>");
  process.exit(2);
}

let compute;
try {
  ({ compute } = await import(pathToFileURL(resolve(workdir, "index.mjs")).href));
} catch (err) {
  console.error("no se pudo importar index.mjs:", err.message);
  process.exit(1);
}

const cases = [
  ["median", "-5 -3 -1", -3], // el bug reportado
  ["mean", "-2 -4", -3],
  ["median", "-1 0 1", 0],
  ["median", "1 2 3", 2], // positivos siguen funcionando
  ["mean", "2 4 6", 4],
];

for (const [kind, input, expected] of cases) {
  let got;
  try {
    got = compute(kind, input);
  } catch (err) {
    console.error(`FAIL: compute(${JSON.stringify(kind)}, ${JSON.stringify(input)}) tiró: ${err.message}`);
    process.exit(1);
  }
  if (got !== expected) {
    console.error(`FAIL: compute(${JSON.stringify(kind)}, ${JSON.stringify(input)}) = ${got}, esperaba ${expected}`);
    process.exit(1);
  }
}

console.log("PASS");
process.exit(0);
