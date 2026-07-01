const reset = "\x1b[0m";
const dim = (s: string) => `\x1b[2m${s}${reset}`; // tenue
const bold = (s: string) => `\x1b[1m${s}${reset}`; // negrita
const cyan = (s: string) => `\x1b[36m${s}${reset}`; // tool calls
const red = (s: string) => `\x1b[31m${s}${reset}`; // errores
const yellow = (s: string) => `\x1b[33m${s}${reset}`; // advertencias
const gray = (s: string) => `\x1b[90m${s}${reset}`; // output de tools
const green = (s: string) => `\x1b[32m${s}${reset}`;
const magenta = (s: string) => `\x1b[35m${s}${reset}`; // input del humano (tu turno)
const color = (s: string, code: string) => `\x1b[${code}m${s}\x1b[0m`;

export { bold, color, cyan, dim, gray, green, magenta, red, yellow, reset };
