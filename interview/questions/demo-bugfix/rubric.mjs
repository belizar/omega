// Rúbrica de demo-bugfix: verifica que add() suma. Corre contra el workdir del
// candidate (argv[2]) DESPUÉS de que omega tocó el código. Exit 0 = pass, 1 = fail.
// Vive fuera de repo/ a propósito: el candidate nunca la ve (como el test escondido
// de SWE-bench). El éxito lo decide este script, no el ojo del entrevistador.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const workdir = process.argv[2];
if (!workdir) {
  console.error("uso: node rubric.mjs <workdir>");
  process.exit(2);
}

let add;
try {
  // import fresco del sum.mjs que dejó el candidate.
  ({ add } = await import(pathToFileURL(resolve(workdir, "sum.mjs")).href));
} catch (err) {
  console.error("no se pudo importar sum.mjs:", err.message);
  process.exit(1);
}

const cases = [
  [2, 3, 5],
  [0, 0, 0],
  [-1, 1, 0],
  [10, 5, 15],
];

for (const [a, b, expected] of cases) {
  const got = add(a, b);
  if (got !== expected) {
    console.error(`FAIL: add(${a}, ${b}) = ${got}, esperaba ${expected}`);
    process.exit(1);
  }
}

console.log("PASS");
process.exit(0);
