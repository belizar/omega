import { cyan, dim, gray } from "../theme.js";
import { MarkdownRenderer, ColumnAlign } from "../markdown/types.js";
import { PlainRenderer } from "../markdown/plain-renderer.js";
import { Screen } from "../screen.js";

interface DisplayText {
  display(text: string): void;
}

/** Estado del parser de markdown (línea por línea). */
type ParserState = {
  inCodeBlock: boolean;
  codeBlockLang: string | null;
  codeBlockLines: string[];

  /** Para citas multilínea: cuando una línea empieza con "> " inicia la cita.
   * Las líneas siguientes que NO estén en blanco y NO empiecen con otro token
   * (heading, lista, etc.) se consideran continuación de la cita. */
  inBlockquote: boolean;
  blockquoteLines: string[];

  /** Para tablas: cuando vemos | col1 | col2 | seguido de |----|----|
   * entramos en modo tabla y acumulamos filas hasta una línea en blanco. */
  inTable: boolean;
  tableHeaders: string[];
  tableAlignments: ColumnAlign[];
  tableRows: string[][];

  /**
   * Contadores 1-based para listas ordenadas, key = nivel de indentación.
   * Se resetean los niveles más profundos cuando aparece un item de un nivel.
   */
  orderedCounters: Map<number, number>;
  /** Último depth de list item procesado (para resetear al salir de lista). */
  lastListDepth: number;
};

/**
 * Los display imprimen ARRIBA de la región viva (vía screen.printAbove), no
 * directo a stdout, así no pisan el editor fijo abajo. Cada uno aplica su
 * estilo.
 */
class DisplayAssistantText implements DisplayText {
  #screen: Screen;
  #renderer: MarkdownRenderer;
  #buffer = "";
  #streaming = false;
  #parserState: ParserState;
  /** Trackea si el último output fue un paragraphBreak para no duplicar. */
  #lastWasBlank = false;

  constructor(screen: Screen, renderer?: MarkdownRenderer) {
    this.#screen = screen;
    this.#renderer = renderer ?? new PlainRenderer();
    this.#parserState = this.#newParserState();
  }

  /** Muestra un chunk de texto (modo streaming). Acumula en buffer,
   * flushea líneas completas al scrollback y mantiene la línea en
   * progreso como texto efímero. Cada línea se parsea como markdown antes
   * de ser renderizada. */
  displayStream(chunk: string): void {
    this.#streaming = true;
    this.#buffer += chunk;

    const lines = this.#buffer.split("\n");
    const complete = lines.slice(0, -1);
    const partial = lines[lines.length - 1];

    // Flushear líneas completas al scrollback (parseadas como markdown)
    if (complete.length > 0) {
      this.#screen.clearEphemeral();
      for (const line of complete) {
        this.#processLine(line);
      }
    }

    // Mostrar la línea en progreso como texto efímero (parseo inline ligero)
    this.#screen.writeEphemeral(this.#renderer.text(this.#renderInline(partial)));
    this.#buffer = partial;
  }

  /** Cierra el streaming: limpia el texto efímero y flushea el resto. */
  endStream(): void {
    if (!this.#streaming) return;
    this.#streaming = false;
    this.#screen.clearEphemeral();

    // Flushear lo que quedó (puede ser una línea sin \n final)
    if (this.#buffer.length > 0) {
      this.#processLine(this.#buffer);
    }

    // Cerrar code block si quedó abierto (sin ``` de cierre)
    this.#flushCodeBlock();

    // Flushear línea pendiente (posible header de tabla sin separador)
    this.#flushPendingLine();

    // Cerrar table si quedó abierta (sin línea en blanco final)
    this.#flushTable();

    this.#buffer = "";
  }

  display(text: string): void {
    // Modo no-streaming: partimos en líneas y parseamos cada una
    for (const line of text.split("\n")) {
      this.#processLine(line);
    }
  }

  // ── parser por líneas ───────────────────────────────────────────

  #newParserState(): ParserState {
    return {
      inCodeBlock: false,
      codeBlockLang: null,
      codeBlockLines: [],
      inBlockquote: false,
      blockquoteLines: [],
      inTable: false,
      tableHeaders: [],
      tableAlignments: [],
      tableRows: [],
      orderedCounters: new Map(),
      lastListDepth: 0,
    };
  }

  #processLine(line: string): void {
    const state = this.#parserState;

    // ── code block ──────────────────────────────────────────────
    if (state.inCodeBlock) {
      if (line.trim() === "```") {
        this.#flushCodeBlock();
      } else {
        state.codeBlockLines.push(line);
      }
      return;
    }

    // ── tabla ───────────────────────────────────────────────────
    if (state.inTable) {
      const tableClean = line.replace(/<[^>]*>/g, "");
      if (line.trim() === "" || !tableClean.includes("|")) {
        this.#flushTable();
        if (line.trim() === "") return;
        this.#processLine(line);
      } else {
        const cells = this.#parseTableRow(line);
        if (cells.length > 0) state.tableRows.push(cells);
      }
      return;
    }

    // ── resolver línea pendiente (posible header de tabla) ─────
    if (this.#pendingLine !== null) {
      const tableClean = line.replace(/<[^>]*>/g, "");
      if (tableClean.includes("|") && this.#isTableSeparator(line)) {
        // La línea pendiente era el header de una tabla
        this.#flushBlockquote();
        state.tableHeaders = this.#parseTableRow(this.#pendingLine);
        state.tableAlignments = this.#parseAlignments(line);
        state.tableRows = [];
        state.inTable = true;
        this.#pendingLine = null;
        return;
      }
      // No era tabla → flushear la pendiente como párrafo
      this.#flushPendingLine();
      // seguir procesando la línea actual
    }

    // ── línea con | que podría ser header de tabla ─────────────
    // Ignoramos pipes dentro de <...> (ej: "/resume <n|id|nombre>")
    const tableClean = line.replace(/<[^>]*>/g, "");
    if (tableClean.includes("|") && !line.startsWith("> ")) {
      if (this.#isTableSeparator(line)) {
        // Separador sin header previo → línea suelta, párrafo
        this.#lastWasBlank = false;
        this.#screen.printAbove(
          this.#renderer.text(this.#renderInline(line)),
        );
        return;
      }
      // Podría ser header de tabla → diferir, esperar la siguiente línea
      this.#pendingLine = line;
      return;
    }

    // ── code fence inicio ───────────────────────────────────────
    const fenceMatch = line.trim().match(/^```(\S*)$/);
    if (fenceMatch) {
      this.#flushBlockquote();
      state.inCodeBlock = true;
      state.codeBlockLang = fenceMatch[1] || null;
      state.codeBlockLines = [];
      return;
    }

    // ── línea vacía ─────────────────────────────────────────────
    if (line.trim() === "") {
      this.#flushBlockquote();
      if (!this.#lastWasBlank) {
        this.#screen.printBlankLine();
        this.#lastWasBlank = true;
      }
      return;
    }

    // ── blockquote ──────────────────────────────────────────────
    if (line.startsWith("> ")) {
      if (!state.inBlockquote) {
        this.#flushBlockquote();
        state.inBlockquote = true;
        state.blockquoteLines = [];
      }
      state.blockquoteLines.push(line.slice(2));
      return;
    }

    // ¿Continuación de blockquote? (línea no vacía que no es otro token)
    if (state.inBlockquote) {
      const isOtherBlock =
        /^#{1,6}\s/.test(line) ||
        /^(-{3,}|\*{3,})\s*$/.test(line.trim()) ||
        /^(\s*)([-*]|\d+\.)\s+/.test(line);
      if (!isOtherBlock) {
        state.blockquoteLines.push(line);
        return;
      }
      this.#flushBlockquote();
    }

    // ── heading ─────────────────────────────────────────────────
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      if (!this.#lastWasBlank) {
        this.#screen.printBlankLine();
      }
      const level = headingMatch[1].length;
      const text = this.#renderInline(headingMatch[2]);
      this.#screen.printAbove(this.#renderer.heading(text, level));
      this.#screen.printBlankLine();
      this.#lastWasBlank = true;
      return;
    }

    // ── HR → lo tratamos como una línea en blanco (sin raya full-width) ──
    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      if (!this.#lastWasBlank) {
        this.#screen.printBlankLine();
        this.#lastWasBlank = true;
      }
      return;
    }

    // ── list item ───────────────────────────────────────────────
    // Soporta: "- [x] texto", "* [ ] texto", "1. [x] texto", "- texto", "1. texto"
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(?:\[([ xX])\]\s+)?(.+)/);
    if (listMatch) {
      const depth = Math.floor(listMatch[1].length / 2);
      const ordered = /^\d+\.$/.test(listMatch[2]);
      const check = listMatch[3]?.toLowerCase();
      const checked = check === "x" ? true : check === " " ? false : undefined;
      const text = this.#renderInline(listMatch[4]);

      // Auto-numerar listas ordenadas
      let index: number | null = null;
      if (ordered) {
        let counter = state.orderedCounters.get(depth) ?? 1;
        index = counter;
        state.orderedCounters.set(depth, counter + 1);
      } else {
        // Una lista no-ordenada del mismo nivel mantiene el contador anterior
        // (no reseteamos los niveles más profundos porque puede haber anidación)
      }

      // Resetear contadores de niveles más profundos que éste
      for (const key of state.orderedCounters.keys()) {
        if (key > depth) state.orderedCounters.delete(key);
      }

      state.lastListDepth = depth;
      this.#lastWasBlank = false;
      this.#screen.printAbove(this.#renderer.listItem(text, index, depth, checked));
      return;
    }

    // Al salir de listas, resetear contadores
    if (/^(\s*)([-*]|\d+\.)\s+/.test(line) === false && line.trim() !== "") {
      state.orderedCounters.clear();
      state.lastListDepth = 0;
    }

    // ── línea que ARRANCA con **negrita** → título de sección, con espaciado.
    //    El modelo escribe los títulos así ("**1. Entry point** (src/index.ts)")
    //    en vez de usar ## headings. Renderizamos la línea normal (negrita + el
    //    resto, ej. el path en cyan) pero con línea en blanco alrededor. ──
    if (/^\*\*/.test(line.trim())) {
      if (!this.#lastWasBlank) {
        this.#screen.printBlankLine();
      }
      this.#screen.printAbove(this.#renderer.text(this.#renderInline(line)));
      this.#screen.printBlankLine();
      this.#lastWasBlank = true;
      return;
    }

    // ── párrafo ─────────────────────────────────────────────────
    this.#lastWasBlank = false;
    this.#screen.printAbove(
      this.#renderer.text(this.#renderInline(line)),
    );
  }

  /** Reemplaza inlines: **bold**, *italic*, ~~strike~~, `code`, [links](url), ![img](url), [^footnote] */
  #renderInline(text: string): string {
    const r = this.#renderer;
    let out = text;
    // Imágenes: ![alt](url) — antes que links para que no matcheen mal
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => r.image(alt, url));
    // Links: [text](url)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => r.link(t, u));
    // Footnote references: [^id]
    out = out.replace(/\[\^([^\]]+)\]/g, (_, id) => r.footnoteRef(id));
    out = out.replace(/\*\*(.+?)\*\*/g, (_, t) => r.strong(t));
    out = out.replace(/~~(.+?)~~/g, (_, t) => r.strikethrough(t));
    out = out.replace(/\*(.+?)\*/g, (_, t) => r.em(t));
    out = out.replace(/`([^`]+)`/g, (_, t) => r.codespan(t));
    return out;
  }

  // ── flush helpers ───────────────────────────────────────────

  #flushCodeBlock(): void {
    const state = this.#parserState;
    if (state.codeBlockLines.length === 0 && !state.codeBlockLang) {
      state.inCodeBlock = false;
      return;
    }
    const code = state.codeBlockLines.join("\n");
    this.#lastWasBlank = false;
    this.#screen.printAbove(
      this.#renderer.codeBlock(code, state.codeBlockLang ?? undefined),
    );
    state.inCodeBlock = false;
    state.codeBlockLang = null;
    state.codeBlockLines = [];
  }

  #flushBlockquote(): void {
    const state = this.#parserState;
    if (!state.inBlockquote) return;
    const text = state.blockquoteLines
      .map((l) => this.#renderInline(l))
      .join("\n");
    // Cada línea como un blockquote individual
    this.#lastWasBlank = false;
    for (const line of state.blockquoteLines) {
      this.#screen.printAbove(
        this.#renderer.blockquote(this.#renderInline(line)),
      );
    }
    state.inBlockquote = false;
    state.blockquoteLines = [];
  }

  #flushTable(): void {
    const state = this.#parserState;
    if (!state.inTable || state.tableHeaders.length === 0) {
      state.inTable = false;
      return;
    }
    this.#lastWasBlank = false;
    this.#screen.printAbove(
      this.#renderer.table(state.tableHeaders, state.tableRows, state.tableAlignments),
    );
    state.inTable = false;
    state.tableHeaders = [];
    state.tableAlignments = [];
    state.tableRows = [];
  }

  // ── table helpers ───────────────────────────────────────────

  #isTableSeparator(line: string): boolean {
    const trimmed = line.trim();
    return /^\|?\s*\|?[\s:-]+\|[\s|:-]+\|?\s*$/.test(trimmed) &&
      trimmed.includes("-") && trimmed.includes("|");
  }

  #parseTableRow(line: string): string[] {
    return line
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
  }

  #parseAlignments(sepLine: string): ColumnAlign[] {
    return sepLine
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .map((c) => {
        const left = c.startsWith(":");
        const right = c.endsWith(":");
        if (left && right) return "center" as const;
        if (right) return "right" as const;
        return "left" as const;
      });
  }

  /**
   * Línea diferida: si una línea con | podría ser header de tabla,
   * la guardamos acá en vez de imprimirla. Si la siguiente es un
   * separador (|----|), se consume como header. Si no, se flushea
   * como párrafo normal.
   */
  #pendingLine: string | null = null;

  #flushPendingLine(): void {
    if (this.#pendingLine === null) return;
    const line = this.#pendingLine;
    this.#pendingLine = null;
    this.#lastWasBlank = false;
    this.#screen.printAbove(
      this.#renderer.text(this.#renderInline(line)),
    );
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
      case "outline":
        return `outline ${this.#pathStr(obj)}`;
      case "bash":
        if (typeof obj.command === "string") {
          return `bash ${this.#truncateCmd(obj.command)}`;
        }
        return "bash";
      case "grep":
        return `grep "${obj.pattern ?? "?"}" ${this.#pathStr(obj)}`;
      case "vision_ask":
        if (typeof obj.question === "string") {
          return `vision_ask "${obj.question.slice(0, 60)}${obj.question.length > 60 ? "..." : ""}"`;
        }
        return "vision_ask";
      case "tool_search":
        if (typeof obj.query === "string") {
          return `tool_search "${obj.query}"`;
        }
        return "tool_search";
      case "ask_user":
        if (typeof obj.question === "string") {
          return `ask_user "${obj.question.slice(0, 60)}${obj.question.length > 60 ? "..." : ""}"`;
        }
        return "ask_user";
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
