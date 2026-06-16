import { execSync } from "child_process";
import { existsSync, statSync } from "fs";
import { resolve, relative } from "path";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";
import { isEnvFile } from "./env-guard.js";

type GrepInput = {
  pattern: string;
  path?: string;
  include?: string;
  contextLines?: number;
  maxResults?: number;
};

type GrepMatch = {
  file: string;
  line: number;
  column: number;
  match: string;
  context: string;
};

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 5 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 50;

export class GrepTool extends Tool<GrepInput, string> {
  constructor() {
    super({
      name: "grep",
      description:
        "Busca un patrón regex en archivos del proyecto, devolviendo número de línea, columna y contexto alrededor de cada match.",
      schema: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Patrón regex (grep -E) a buscar. Ej: 'export.*class', 'TODO'",
          },
          path: {
            type: "string",
            description:
              "Directorio o archivo donde buscar. Por defecto: el directorio actual (cwd).",
          },
          include: {
            type: "string",
            description:
              "Glob para filtrar archivos (ej: '*.ts', 'src/**/*.js'). Se pasa a grep con --include.",
          },
          contextLines: {
            type: "number",
            description:
              "Líneas de contexto antes y después de cada match (default: 2).",
          },
          maxResults: {
            type: "number",
            description:
              `Máximo de resultados a devolver (default: ${DEFAULT_MAX_RESULTS}).`,
          },
        },
        required: ["pattern"],
      },
    });
  }

  execute(input: GrepInput): string {
    const {
      pattern,
      path: searchPath = ".",
      include,
      contextLines = 2,
      maxResults = DEFAULT_MAX_RESULTS,
    } = input;

    if (!pattern || typeof pattern !== "string") {
      return "Error: pattern es requerido y debe ser un string";
    }

    const absPath = resolve(searchPath);
    if (isEnvFile(absPath)) {
      return "Error: no se puede buscar en archivos .env por seguridad";
    }

    const isFile = existsSync(absPath) && statSync(absPath).isFile();

    try {
      const args: string[] = [
        "-rnE",          // recursivo, números de línea, regex extendido
        "--color=never", // sin códigos ANSI
        "-C", String(contextLines),
      ];

      if (include) {
        args.push("--include", include);
      }

      // Escapar el patrón para shell
      args.push("-e", pattern);

      if (isFile) {
        args.push(absPath);
      } else {
        args.push(absPath);
      }

      const result = execSync(`grep ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
        encoding: "utf-8",
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        cwd: process.cwd(),
      });

      if (!result.trim()) {
        return "Sin resultados.";
      }

      const lines = result.trim().split("\n");
      const limited = lines.slice(0, maxResults * ((contextLines * 2) + 1 + 1)); // matches + context + separators
      const truncated = lines.length > limited.length
        ? limited.join("\n") + `\n... (${lines.length - limited.length} líneas omitidas, ${Math.round(lines.length / (contextLines * 2 + 1))} resultados aprox.)`
        : limited.join("\n");

      // Formatear: agregar filepath relativo y cabecera
      const header = `${limited.length} líneas de resultados`;
      const summary = `\n-- grep "${pattern}" en ${relative(process.cwd(), absPath) || "."} --`;

      return `${summary}\n${truncated}`;
    } catch (err: unknown) {
      const error = err as { code?: string; signal?: string; stderr?: string; stdout?: string; message?: string };
      // grep devuelve exit code 1 cuando no hay matches (no es error)
      if (error.code === "ETIMEDOUT" || error.signal === "SIGTERM") {
        return `Error: búsqueda cancelada por timeout (${TIMEOUT_MS}ms)`;
      }
      if (error.stderr && !error.stderr.includes("No such file")) {
        logger.error("Grep command failed", { pattern, error: error.stderr || error.message });
        return `Error: ${error.stderr || error.message}`;
      }
      return "Sin resultados.";
    }
  }
}
