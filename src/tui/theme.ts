const reset = "\x1b[0m";
const dim = (s: string) => `\x1b[2m${s}${reset}`; // tenue
const cyan = (s: string) => `\x1b[36m${s}${reset}`; // tool calls
const red = (s: string) => `\x1b[31m${s}${reset}`; // errores
const gray = (s: string) => `\x1b[90m${s}${reset}`; // output de tools
const color = (s: string, code: string) => `\x1b[${code}m${s}\x1b[0m`;

export { color, cyan, dim, gray, red, reset };
