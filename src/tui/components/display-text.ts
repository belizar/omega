import { cyan, dim, gray } from "../theme.js";
import { Screen } from "../screen.js";

interface DisplayText {
  display(text: string): void;
}

/**
 * Los display imprimen ARRIBA de la región viva (vía screen.printAbove), no
 * directo a stdout, así no pisan el editor fijo abajo. Cada uno aplica su
 * estilo.
 */
class DisplayAssistantText implements DisplayText {
  #screen: Screen;
  #streamingBuffer = "";
  #streaming = false;

  constructor(screen: Screen) {
    this.#screen = screen;
  }

  /** Muestra un chunk de texto (modo streaming). Acumula en buffer y
   * va imprimiendo incrementalmente sin LF. */
  displayStream(chunk: string): void {
    this.#streaming = true;
    this.#streamingBuffer += chunk;
    this.#screen.printAboveRaw(dim(this.#streamingBuffer));
  }

  /** Cierra el bloque de streaming. El último displayStream ya fijó el
   * texto en el scrollback; solo limpiamos el buffer interno. */
  endStream(): void {
    if (!this.#streaming) return;
    this.#streaming = false;
    this.#streamingBuffer = "";
  }

  display(text: string): void {
    this.#screen.printAbove(dim(text));
  }
}

/**
 * Tool call compacto: "> read src/index.ts" o "> bash 'git status'".
 * Verbose: igual que compacto (el input ya es visible).
 */
class DisplayToolCall {
  #screen: Screen;
  constructor(screen: Screen) {
    this.#screen = screen;
  }

  call(name: string, input: unknown, _verbose: boolean): void {
    const desc = this.#describeInput(name, input);
    this.#screen.printAbove(cyan(`> ${desc}`));
  }

  #describeInput(name: string, input: unknown): string {
    if (!input || typeof input !== "object") return name;
    const obj = input as Record<string, unknown>;

    // Extraer el argumento más descriptivo según la tool
    switch (name) {
      case "read":
        return `read ${this.#pathStr(obj)}`;
      case "write":
        return `write ${this.#pathStr(obj)}`;
      case "edit":
        return `edit ${this.#pathStr(obj)}`;
      case "bash":
        if (typeof obj.command === "string") {
          return `bash ${this.#truncateCmd(obj.command)}`;
        }
        return "bash";
      case "grep":
        return `grep "${obj.pattern ?? "?"}" ${this.#pathStr(obj)}`;
      default:
        return name;
    }
  }

  #pathStr(obj: Record<string, unknown>): string {
    return typeof obj.path === "string" ? obj.path : "?";
  }

  #truncateCmd(cmd: string): string {
    return cmd.length > 70 ? `'${cmd.slice(0, 67)}...'` : `'${cmd}'`;
  }
}

/**
 * Tool result: en modo compacto muestra un resumen de una línea.
 * En modo verbose, vuelca el contenido completo.
 */
class DisplayToolResult {
  #screen: Screen;
  constructor(screen: Screen) {
    this.#screen = screen;
  }

  result(output: string, verbose: boolean, rawOutput?: string): void {
    const summarySource = rawOutput ?? output;
    if (verbose) {
      if (output.length > 0) {
        this.#screen.printAbove(gray(output));
      }
      return;
    }

    const summary = this.#summarize(summarySource);
    this.#screen.printAbove(gray(`  = ${summary}`));
  }

  #summarize(output: string): string {
    if (!output || output.trim() === "") return "vacío";

    const lines = output.split("\n");
    const chars = output.length;
    const L = lines.length;

    // Resúmenes por tipo de contenido
    if (L === 1 && chars < 120) {
      return output.trim();
    }

    if (output.startsWith("Error")) {
      // Errores: mostrar la primera línea (el mensaje principal)
      return output.split("\n")[0].trim();
    }

    const sizeStr = chars >= 1000
      ? `${(chars / 1000).toFixed(1)}K`
      : `${chars}`;

    return `${L} líneas · ${sizeStr} chars`;
  }
}

export { DisplayAssistantText, DisplayToolCall, DisplayToolResult };
