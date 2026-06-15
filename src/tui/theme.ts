const reset = "\x1b[0m";
const dim = (s: string) => `\x1b[2m${s}${reset}`; // tenue
const bold = (s: string) => `\x1b[1m${s}${reset}`; // negrita
const cyan = (s: string) => `\x1b[36m${s}${reset}`; // tool calls
const red = (s: string) => `\x1b[31m${s}${reset}`; // errores
const gray = (s: string) => `\x1b[90m${s}${reset}`; // output de tools
const green = (s: string) => `\x1b[32m${s}${reset}`;
const color = (s: string, code: string) => `\x1b[${code}m${s}\x1b[0m`;

export { bold, color, cyan, dim, gray, green, red, reset };
