import { MarkdownRenderer, ColumnAlign } from "./types.js";
import { bold, cyan, dim, gray, green } from "../theme.js";
import { stdout } from "process";

const { columns } = stdout;

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
    return dim(text);
  }

  codeBlock(code: string, language?: string): string {
    const header = language ? dim(` ${language} `) : "";
    const lines = code.split("\n");
    const top = dim("┌" + "─".repeat(Math.min(60, (columns ?? 80) - 2)) + header);
    const out = lines.map((l) => dim("│ " + l)).join("\n");
    const bottom = dim("└" + "─".repeat(Math.min(60, (columns ?? 80) - 2)));
    return [top, out, bottom].join("\n");
  }

  heading(text: string, level: number): string {
    switch (level) {
      case 1:
        return bold(cyan(text));
      case 2:
        return bold(cyan(text));
      default:
        return bold(text);
    }
  }

  blockquote(text: string): string {
    return dim("│ ") + dim(text);
  }

  table(headers: string[], rows: string[][], alignments: ColumnAlign[]): string {
    const widths: number[] = headers.map((_, ci) => {
      let max = headers[ci].length;
      for (const row of rows) {
        const cell = row[ci] ?? "";
        if (cell.length > max) max = cell.length;
      }
      return Math.max(max, 3);
    });

    const pad = (text: string, w: number, align: ColumnAlign): string => {
      const diff = w - text.length;
      if (align === "right") return " ".repeat(diff) + text;
      if (align === "center") {
        const left = Math.floor(diff / 2);
        return " ".repeat(left) + text + " ".repeat(diff - left);
      }
      return text + " ".repeat(diff); // left
    };

    const sep = dim("│");
    const makeRow = (cells: string[], boldFn: (s: string) => string = (s) => s) =>
      sep + cells.map((c, i) => " " + boldFn(pad(c, widths[i], alignments[i] ?? "left")) + " ").join(sep) + sep;

    const hdr = makeRow(headers, (s) => bold(s));
    const divider = sep + widths.map((w) => "─".repeat(w + 2)).join(sep) + sep;
    const body = rows.map((row) => makeRow(row));

    return [hdr, dim(divider), ...body].join("\n");
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
    return dim("─".repeat((columns ?? 80) - 2));
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
