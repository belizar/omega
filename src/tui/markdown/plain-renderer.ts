import { MarkdownRenderer, ColumnAlign } from "./types.js";

/**
 * Renderer que devuelve el texto sin formato ANSI.
 * Útil para tests y para ver la salida "cruda" del parser.
 */
class PlainRenderer implements MarkdownRenderer {
  text(text: string): string {
    return text;
  }

  strong(text: string): string {
    return text;
  }

  em(text: string): string {
    return text;
  }

  strikethrough(text: string): string {
    return text;
  }

  codespan(text: string): string {
    return text;
  }

  codeBlock(code: string): string {
    return code;
  }

  heading(text: string, _level: number): string {
    return text.toUpperCase();
  }

  blockquote(text: string): string {
    return `| ${text}`;
  }

  table(headers: string[], rows: string[][]): string {
    const hdr = headers.join(" | ");
    const sep = headers.map(() => "---").join(" | ");
    const body = rows.map((row) => row.join(" | "));
    return [hdr, sep, ...body].join("\n");
  }

  listItem(text: string, index: number | null, depth: number, checked?: boolean): string {
    const indent = "  ".repeat(depth);
    let bullet: string;
    if (checked !== undefined) {
      bullet = checked ? "[x]" : "[ ]";
    } else if (index !== null) {
      bullet = `${index}.`;
    } else {
      bullet = "-";
    }
    return `${indent}${bullet} ${text}`;
  }

  hr(): string {
    return "---";
  }

  link(text: string, url: string): string {
    return `${text} (${url})`;
  }

  image(alt: string, url: string): string {
    return `[IMG: ${alt || url}]`;
  }

  footnoteRef(id: string): string {
    return `[^${id}]`;
  }

  paragraphBreak(): string {
    return "";
  }
}

export { PlainRenderer };