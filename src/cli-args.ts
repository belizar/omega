import { HeadlessFormat } from "./frontend/headless-frontend.js";

export interface CliArgs {
  /** true si se pidió modo headless (`-p` / `--print`). */
  headless: boolean;
  /** El prompt one-shot, o null si hay que leerlo de stdin (`-p -` o sin valor). */
  prompt: string | null;
  /** Formato de salida headless. Default: json (el consumidor primario es máquina). */
  format: HeadlessFormat;
  /** Override del modelo primario para esta corrida (`--model`). Null = usar el
   *  del perfil/config. Clave para interviews: variar el candidate por corrida. */
  model: string | null;
  /** Temperatura de sampling (`--temp`). Null = no se manda (default del
   *  proveedor). Bajarla reduce la varianza corrida-a-corrida en interviews. */
  temp: number | null;
  /** true si se pidió el frontend web (`--serve`): hostea el core tras un
   *  server HTTP y se maneja desde el browser. */
  serve: boolean;
  /** true si se pidió el mission-control en la terminal (`omega mc`): la TUI como
   *  cliente del daemon (lista de sesiones + chat, el turno corre en el daemon). */
  mc: boolean;
  /** Puerto del server/daemon (`--port`). Default 4477. */
  port: number;
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
  let model: string | null = null;
  let temp: number | null = null;
  let serve = false;
  let mc = false;
  let port = 4477;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "mc" || arg === "--mc") {
      mc = true;
      continue;
    }
    if (arg === "--serve") {
      serve = true;
      continue;
    }
    if (arg === "--port") {
      const n = parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isNaN(n)) { port = n; i++; }
      continue;
    }
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
    } else if (arg === "--model") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        model = next;
        i++;
      }
    } else if (arg === "--temp") {
      const next = argv[i + 1];
      const n = Number(next);
      if (next !== undefined && !Number.isNaN(n)) {
        temp = n;
        i++;
      }
    }
  }

  return { headless, prompt, format, model, temp, serve, mc, port };
}
