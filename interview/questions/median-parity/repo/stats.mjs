// Estadísticos sobre un array de números.
export function mean(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  // BUG: devuelve siempre el elemento del medio-bajo. Correcto para largo impar,
  // pero para largo par debería ser el promedio de los dos centrales.
  return s[mid];
}
