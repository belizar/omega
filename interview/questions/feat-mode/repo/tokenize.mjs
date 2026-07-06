// Divide la entrada en tokens numéricos (crudos, como strings).
export function tokenize(input) {
  return input.trim().split(/\s+/).filter(Boolean);
}
