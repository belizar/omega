// Rúbrica de feat-mode: compute("mode", …) devuelve el valor más frecuente, sin
// romper mean/median. Corre contra el workdir del candidate (argv[2]).
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

// Todos los casos tienen un mode ÚNICO (sin empates), para que la rúbrica no
// dependa de cómo el candidate desempata.
const cases = [
  ["mode", "1 2 2 3", 2], // el ejemplo del brief
  ["mode", "5 5 5 1 2", 5],
  ["mode", "7", 7],
  ["median", "1 2 3", 2], // los que ya existían siguen funcionando
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
