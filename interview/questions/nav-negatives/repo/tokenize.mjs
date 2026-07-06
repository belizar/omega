// Divide la entrada en tokens numéricos (crudos, como strings).
export function tokenize(input) {
  // BUG: \d+ matchea solo dígitos → se come el signo menos. "-5" → "5".
  return input.match(/\d+/g) ?? [];
}
