// Estadísticos sobre un array de números.
export function mean(nums) {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
