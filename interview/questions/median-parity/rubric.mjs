// Rúbrica de median-parity: la mediana correcta para largo PAR (promedio de los
// dos centrales) SIN romper el largo IMPAR. La trampa: un fix que promedia los
// dos centrales SIEMPRE rompe los impares — y acá se testean ambos.
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
  ["median", "1 2 3 4", 2.5], // par — el bug reportado
  ["median", "10 20", 15], // par
  ["median", "1 2 3", 2], // impar — NO se debe romper (la trampa)
  ["median", "5", 5], // impar, un solo elemento
  ["median", "4 1 3 2 5", 3], // impar, desordenado
  ["mean", "2 4 6", 4], // mean sigue andando
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
