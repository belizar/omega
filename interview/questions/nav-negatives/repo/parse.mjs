import { tokenize } from "./tokenize.mjs";

// Convierte la entrada en un array de números.
export function parse(input) {
  return tokenize(input).map(Number);
}
