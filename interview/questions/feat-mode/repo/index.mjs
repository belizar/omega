import { parse } from "./parse.mjs";
import { mean, median } from "./stats.mjs";

// compute("median", "3 1 2") → 2
export function compute(kind, input) {
  const nums = parse(input);
  switch (kind) {
    case "mean":
      return mean(nums);
    case "median":
      return median(nums);
    default:
      throw new Error(`stat desconocido: ${kind}`);
  }
}
