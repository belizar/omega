import { HeadlessFormat } from "./frontend/headless-frontend.js";

export interface CliArgs {
  /** true si se pidió modo headless (`-p` / `--print`). */
  headless: boolean;
  /** El prompt one-shot, o null si hay que leerlo de stdin (`-p -` o sin valor). */
  prompt: string | null;
  /** Formato de salida headless. Default: json (el consumidor primario es máquina). */
  format: HeadlessFormat;
}

/**
 * Parser mínimo de argumentos para el modo headless. Sin dependencias: Omega
 * corre casi siempre como TUI, y headless es un puñado de flags.
 *
 *   omega -p "arreglá el test"        → headless, prompt inline, json
 *   omega --print "…" --format text   → headless, salida texto
 *   omega -p -                        → headless, prompt desde stdin
 *   cat task.txt | omega -p           → idem (sin valor tras -p → stdin)
 *   omega                             → TUI (headless=false)
 */
export function parseCliArgs(argv: string[]): CliArgs {
  let headless = false;
  let prompt: string | null = null;
  let format: HeadlessFormat = "json";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--print") {
      headless = true;
      const next = argv[i + 1];
      // El valor es el prompt salvo que sea otro flag, "-" (stdin) o falte.
      if (next !== undefined && next !== "-" && !next.startsWith("-")) {
        prompt = next;
        i++;
      } else {
        prompt = null; // leer de stdin
        if (next === "-") i++;
      }
    } else if (arg === "--format") {
      const next = argv[i + 1];
      if (next === "text" || next === "json") {
        format = next;
        i++;
      }
    }
  }

  return { headless, prompt, format };
}
