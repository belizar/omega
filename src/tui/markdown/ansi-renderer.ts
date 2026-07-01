import { MarkdownRenderer, ColumnAlign } from "./types.js";
import { bold, cyan, dim, gray, green } from "../theme.js";
import { stdout } from "process";

const { columns } = stdout;

// ── Helpers de ancho visible (para tablas) ───────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
/** Ancho de un codepoint: emojis y CJK ocupan 2 celdas en el terminal. */
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2600 && cp <= 0x27bf) || // símbolos misc / dingbats (✅ ⚠ ⏳ …)
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f000 && cp <= 0x1faff) // emoji (🔴 🟡 …)
  ) {
    return 2;
  }
  return 1;
}
/** Ancho visible de un string, ignorando ANSI y contando emojis como 2. */
function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}
/** Rellena a un ancho visible dado (no cuenta ANSI ni sub-cuenta emojis). */
function padVisible(s: string, w: number, align: ColumnAlign): string {
  const diff = w - visibleWidth(s);
  if (diff <= 0) return s;
  if (align === "right") return " ".repeat(diff) + s;
  if (align === "center") {
    const left = Math.floor(diff / 2);
    return " ".repeat(left) + s + " ".repeat(diff - left);
  }
  return s + " ".repeat(diff);
}
/** Envuelve un texto a un ancho visible, por palabras, con hard-break de tokens
 *  más largos que el ancho. Devuelve al menos [""]. */
function wrapToWidth(s: string, w: number): string[] {
  const words = stripAnsi(s).split(/\s+/).filter((x) => x.length > 0);
  const lines: string[] = [];
  let cur = "";
  for (const word of words) {
    if (cur === "") cur = word;
    else if (visibleWidth(cur) + 1 + visibleWidth(word) <= w) cur += ` ${word}`;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);

  // Hard-break de líneas que siguen excediendo (un token larguísimo)
  const out: string[] = [];
  for (const line of lines) {
    if (visibleWidth(line) <= w) {
      out.push(line);
      continue;
    }
    let chunk = "";
    for (const ch of line) {
      if (visibleWidth(chunk) + charWidth(ch.codePointAt(0) ?? 0) > w) {
        out.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    if (chunk) out.push(chunk);
  }
  return out.length > 0 ? out : [""];
}

/**
 * Traduce markdown a secuencias ANSI para renderizado en terminal.
 */
class AnsiRenderer implements MarkdownRenderer {
  text(text: string): string {
    return text;
  }

  strong(text: string): string {
    return bold(text);
  }

  em(text: string): string {
    // italic → \x1b[3m (no todos los terminales lo soportan; graceful fallback)
    return `\x1b[3m${text}\x1b[0m`;
  }

  strikethrough(text: string): string {
    // \x1b[9m tachado (soportado por la mayoría de terminales modernos)
    return `\x1b[9m${text}\x1b[0m`;
  }

  codespan(text: string): string {
    return cyan(text);
  }

  codeBlock(code: string, language?: string): string {
    const w = Math.min(60, (stdout.columns ?? columns ?? 80) - 2);
    const langLabel = language ? ` ${language} ` : "";
    const top = dim("┌" + "─".repeat(w) + langLabel);
    // Sin prefijo │ para que el código sea copiable. Se usa dim para
    // distinguirlo visualmente de la prosa sin romper copy-paste.
    const body = dim(code);
    const bottom = dim("└" + "─".repeat(w));
    return [top, body, bottom].join("\n");
  }

  heading(text: string, level: number): string {
    // Los headings son CONTENIDO (§1), no acción: foreground, nunca cyan.
    // Se diferencian por peso, no por color. h1 lleva subrayado.
    if (level === 1) return `\x1b[1;4m${text}\x1b[0m`; // bold + underline
    return bold(text);
  }

  blockquote(text: string): string {
    return dim("│ ") + dim(text);
  }

  table(headers: string[], rows: string[][], alignments: ColumnAlign[]): string {
    const cols = headers.length;
    if (cols === 0) return "";
    const align = (i: number): ColumnAlign => alignments[i] ?? "left";

    // 1. Ancho natural de cada columna (por ancho visible, emojis = 2).
    const natural = headers.map((h, ci) => {
      let m = visibleWidth(h);
      for (const row of rows) m = Math.max(m, visibleWidth(row[ci] ?? ""));
      return Math.max(m, 3);
    });

    // 2. Capear al ancho del terminal. Overhead de bordes: "│ " + " │" por
    //    columna = 3 por col, + 1 del "│" final.
    const termWidth = (stdout.columns ?? columns ?? 80) - 1;
    const overhead = cols * 3 + 1;
    const widths = [...natural];
    const MIN_COL = 6;
    let total = widths.reduce((a, b) => a + b, 0) + overhead;
    // Encogé la columna más ancha (la de texto absorbe el recorte) hasta entrar.
    while (total > termWidth) {
      let idx = -1;
      let max = MIN_COL;
      for (let i = 0; i < cols; i++) {
        if (widths[i] > max) {
          max = widths[i];
          idx = i;
        }
      }
      if (idx === -1) break; // nada más que encoger
      widths[idx] -= 1;
      total -= 1;
    }

    // 3. Bordes box-drawing.
    const V = dim("│");
    const line = (l: string, mid: string, r: string): string =>
      dim(l + widths.map((w) => "─".repeat(w + 2)).join(mid) + r);
    const top = line("┌", "┬", "┐");
    const sep = line("├", "┼", "┤");
    const bot = line("└", "┴", "┘");

    // 4. Una fila lógica → varias líneas visuales (wrapping por celda).
    const renderRow = (
      cells: string[],
      style: (s: string) => string = (s) => s,
    ): string[] => {
      const wrapped = widths.map((w, i) => wrapToWidth(cells[i] ?? "", w));
      const height = Math.max(...wrapped.map((c) => c.length));
      const visual: string[] = [];
      for (let li = 0; li < height; li++) {
        const parts = wrapped.map((cell, i) =>
          ` ${style(padVisible(cell[li] ?? "", widths[i], align(i)))} `,
        );
        visual.push(V + parts.join(V) + V);
      }
      return visual;
    };

    const out: string[] = [top];
    out.push(...renderRow(headers, (s) => bold(s)));
    out.push(sep);
    for (const row of rows) out.push(...renderRow(row));
    out.push(bot);
    return out.join("\n");
  }

  listItem(text: string, index: number | null, depth: number, checked?: boolean): string {
    const indent = "  ".repeat(depth);
    let bullet: string;
    if (checked !== undefined) {
      bullet = checked ? green("✓") : dim("☐");
    } else if (index !== null) {
      bullet = `${index}.`;
    } else {
      bullet = "•";
    }
    return `${indent}${dim(bullet)} ${text}`;
  }

  hr(): string {
    // No dibujamos divisores full-width (quedaban feos). Un --- del modelo se
    // vuelve simplemente una línea en blanco; las secciones ya se separan con
    // los títulos + el espaciado.
    return "";
  }

  link(text: string, url: string): string {
    return `${text} ${gray(`(${url})`)}`;
  }

  image(alt: string, url: string): string {
    return gray(`[IMG: ${alt || url}]`);
  }

  footnoteRef(id: string): string {
    // superíndice: los terminales no tienen superíndice real,
    // usamos dim y paréntesis angulares como notación visual.
    return dim(`[^${id}]`);
  }

  paragraphBreak(): string {
    return "";
  }
}

export { AnsiRenderer };
