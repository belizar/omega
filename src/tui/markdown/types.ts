/** Alineación de columna en una tabla markdown. */
type ColumnAlign = "left" | "center" | "right";

/** Renderer abstracto de elementos markdown. Cada implementación traduce
 * los elementos a un formato concreto (ANSI, HTML, texto plano, etc.). */
interface MarkdownRenderer {
  /** Texto sin markup */
  text(text: string): string;

  /** **bold** */
  strong(text: string): string;

  /** *italic* */
  em(text: string): string;

  /** ~~strikethrough~~ */
  strikethrough(text: string): string;

  /** `inline code` */
  codespan(text: string): string;

  /** Bloque ``` ... ``` */
  codeBlock(code: string, language?: string): string;

  /** #, ##, ### headings */
  heading(text: string, level: number): string;

  /** > blockquote (cada línea de la cita; el parser decide cuándo agrupar). */
  blockquote(text: string): string;

  /** Tabla markdown. headers y rows son arrays de celdas (ya sin pipes). */
  table(headers: string[], rows: string[][], alignments: ColumnAlign[]): string;

  /**
   * - o * list item.
   * @param text   texto del item (sin el bullet, ya procesado inline).
   * @param index  null para unordered (bullet). Número 1-based para ordered.
   * @param depth  nivel de indentación (0, 1, ...).
   * @param checked undefined = normal; true = [x]; false = [ ].
   */
  listItem(text: string, index: number | null, depth: number, checked?: boolean): string;

  /** --- horizontal rule */
  hr(): string;

  /** [text](url) */
  link(text: string, url: string): string;

  /** ![alt](url) */
  image(alt: string, url: string): string;

  /** [^id] footnote reference */
  footnoteRef(id: string): string;

  /** Línea en blanco (separación de párrafos) */
  paragraphBreak(): string;
}

export type { MarkdownRenderer, ColumnAlign };
