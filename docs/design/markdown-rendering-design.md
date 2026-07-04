# Diseño: Renderizado de Markdown en la TUI

## Motivación

Hoy el output del assistant se muestra con `dim(text)`, sin distinción entre párrafos, código, negritas, etc. El LLM suele responder en markdown, y ese markup se ve crudo: `**negrita**`, `` `codigo` ``, `### Titulo`, etc.

Queremos parsear markdown y traducirlo a secuencias ANSI para que se vea formateado en la terminal. Pero la arquitectura debe permitir **cambiar el renderer** sin tocar la lógica de streaming/buffering: hoy ANSI, mañana HTML para una UI web.

## El patrón: Strategy

La lógica de buffering/streaming (cuándo flushear, cómo manejar chunks cortados) vive en `DisplayAssistantText`. El **cómo se formatea cada elemento markdown** se delega a una interfaz `MarkdownRenderer`:

```
DisplayAssistantText  ──usa──>  MarkdownRenderer (interfaz)
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                 │
           AnsiRenderer       PlainTextRenderer    HtmlRenderer
           (hoy)              (sin formato)        (futuro)
```

## Interfaz MarkdownRenderer

```ts
interface MarkdownRenderer {
  /** Texto sin markup */
  text(text: string): string;

  /** **bold** */
  strong(text: string): string;

  /** *italic* */
  em(text: string): string;

  /** `inline code` */
  codespan(text: string): string;

  /** Bloque ``` ... ``` */
  codeBlock(code: string, language?: string): string;

  /** #, ##, ### headings */
  heading(text: string, level: number): string;

  /** > blockquote */
  blockquote(text: string): string;

  /** - o * list item (depth 0, 1, 2...) */
  listItem(text: string, ordered: boolean, depth: number): string;

  /** --- horizontal rule */
  hr(): string;

  /** [text](url) */
  link(text: string, url: string): string;

  /** Línea en blanco (separación de párrafos) */
  paragraphBreak(): string;
}
```

## Implementaciones previstas del renderer

### 1. AnsiRenderer (hoy)

Traduce cada elemento a secuencias ANSI:

| Método | ANSI |
|---|---|
| `strong` | `\x1b[1m` (bold) |
| `em` | `\x1b[3m` (italic, no todos los terminales) |
| `codespan` | `\x1b[2m` (dim) |
| `codeBlock` | Todo el bloque en `\x1b[2m`, borde superior/inferior opcional |
| `heading` | `\x1b[1m\x1b[36m` para `###`, `\x1b[1m\x1b[33m` para `#` |
| `blockquote` | `\x1b[2m` + prefijo `│ ` |
| `listItem` | Indentación con espacios + `•` / `1.` |
| `hr` | Línea de `─` del ancho de terminal |
| `link` | Texto normal + `\x1b[90m` con URL entre paréntesis |
| `paragraphBreak` | `\n` (línea vacía) |

### 2. PlainTextRenderer (debug / logs)

Devuelve el texto sin modificaciones. Solo convierte headings a mayúsculas, ignora markup. Útil para logs y tests.

### 3. HtmlRenderer (futuro)

```html
<strong>texto</strong>
<em>texto</em>
<code>texto</code>
<pre><code class="lang">...</code></pre>
<h3>titulo</h3>
...
```

Para una UI web o exportación.

## Parsing del markdown

### Opción A: Marked + custom renderer (recomendado)

- `marked` (librería estándar, 80KB, sin dependencias extra).
- Parsea a tokens o AST.
- Le pasamos un `Renderer` custom que en vez de emitir HTML, llama a `MarkdownRenderer`.
- Pros: parseo robusto, soporta GFM (tables, task lists, strikethrough).
- Contras: dependencia externa.

#### Cómo se integra con streaming

`marked` tiene `Lexer` que devuelve tokens sin procesar. Podemos:

1. Acumular chunks en buffer hasta tener al menos una línea completa.
2. Para cada línea completa (o bloque completo en caso de fences), pasar **solo lo nuevo** al lexer/parser.
3. El parser devuelve tokens markdown que traducimos llamando al `MarkdownRenderer`.
4. Lo que quede incompleto (última línea sin `\n`) queda en buffer.

El desafío es que `marked` no está diseñado para streaming incremental nativo. Hay dos estrategias:

#### Estrategia 1: Parser por líneas (simplista pero efectiva)

No usar marked. Regex por línea. Cada línea se clasifica:

```
"### Titulo"           → heading
"> cita"               → blockquote
"- item" o "* item"    → listItem
"```lang"              → inicio codeBlock
"```"                  → fin codeBlock
"**texto**"            → strong inline
"`codigo`"             → codespan inline
""                     → paragraphBreak
```

Estado interno:

```ts
type ParserState = {
  inCodeBlock: boolean;
  codeBlockLang: string | null;
  codeBlockLines: string[];
  inBlockquote: boolean;
};
```

Cada línea que entra se clasifica, se resuelven los inlines (`**`, `` ` ``) con regex, se llama al renderer, y se flushea.

**Pros**: cero dependencias, streaming trivial (una línea = una decisión), 100 líneas de parser.
**Contras**: no maneja markdown complejo (listas anidadas multilínea, HTML inline, footnotes).

Para el 95% del output de un LLM, alcanza sobrado.

#### Estrategia 2: Marked incremental

Usar `marked.Lexer` sobre el buffer completo cada vez que llega un chunk. Los tokens que están "completos" se renderizan y se remueven del buffer. Los tokens "abiertos" (un párrafo que no terminó, un code block no cerrado) quedan en buffer.

Más preciso pero considerablemente más complejo.

### Recomendación

Empezar con **Estrategia 1 (parser por líneas)**. Es simple, no agrega dependencias, y cubre el markdown típico de un LLM. Si más adelante se necesita GFM completo, se migra a marked con Estrategia 2.

## Modificación de DisplayAssistantText

Hoy:

```ts
class DisplayAssistantText {
  #buffer: string;
  // ... displayStream acumula, parte por \n, flushea
}
```

Propuesto:

```ts
class DisplayAssistantText {
  #screen: Screen;
  #renderer: MarkdownRenderer;
  #buffer: string;           // igual que hoy
  #parserState: ParserState; // para code blocks y blockquotes
  #streaming: boolean;

  constructor(screen: Screen, renderer: MarkdownRenderer) {
    this.#screen = screen;
    this.#renderer = renderer;
  }

  displayStream(chunk: string): void {
    this.#streaming = true;
    this.#buffer += chunk;

    const lines = this.#buffer.split("\n");
    const complete = lines.slice(0, -1); // líneas con \n terminado
    const partial = lines[lines.length - 1];

    for (const line of complete) {
      this.#processLine(line);
    }

    // La línea en progreso se muestra como efímero
    if (partial.length > 0) {
      // Parsearla como si fuera una línea normal (mejor que mostrar crudo)
      const rendered = this.#renderer.text(partial);
      this.#screen.writeEphemeral(rendered);
    } else {
      this.#screen.clearEphemeral();
    }

    this.#buffer = partial;
  }

  endStream(): void {
    if (!this.#streaming) return;
    this.#streaming = false;
    this.#screen.clearEphemeral();
    // Flushear lo que quedó (puede ser una línea sin \n final)
    if (this.#buffer.length > 0) {
      this.#processLine(this.#buffer);
    }
    // Cerrar code block si quedó abierto
    if (this.#parserState.inCodeBlock) {
      this.#flushCodeBlock();
    }
    this.#buffer = "";
  }

  // ── privado ──

  #processLine(line: string): void {
    const state = this.#parserState;

    // Si estamos en code block, solo salimos con ```
    if (state.inCodeBlock) {
      if (line.trim() === "```") {
        this.#flushCodeBlock();
      } else {
        state.codeBlockLines.push(line);
      }
      return;
    }

    // Detectar inicio de code block
    const fenceMatch = line.trim().match(/^```(\w*)$/);
    if (fenceMatch) {
      state.inCodeBlock = true;
      state.codeBlockLang = fenceMatch[1] || null;
      state.codeBlockLines = [];
      return;
    }

    // Línea vacía
    if (line.trim() === "") {
      this.#screen.printAbove(this.#renderer.paragraphBreak());
      return;
    }

    // Heading: ### Titulo
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = this.#renderInline(headingMatch[2]);
      this.#screen.printAbove(this.#renderer.heading(text, level));
      return;
    }

    // Blockquote: > texto
    if (line.startsWith("> ")) {
      const text = this.#renderInline(line.slice(2));
      this.#screen.printAbove(this.#renderer.blockquote(text));
      return;
    }

    // HR: --- o *** solos
    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      this.#screen.printAbove(this.#renderer.hr());
      return;
    }

    // List item: "- texto" o "* texto" o "1. texto"
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)/);
    if (listMatch) {
      const depth = Math.floor(listMatch[1].length / 2);
      const ordered = /^\d+\.$/.test(listMatch[2]);
      const text = this.#renderInline(listMatch[3]);
      this.#screen.printAbove(this.#renderer.listItem(text, ordered, depth));
      return;
    }

    // Párrafo normal
    this.#screen.printAbove(this.#renderer.text(this.#renderInline(line)));
  }

  /** Reemplaza inlines: **bold**, *italic*, `code`, [links](url) */
  #renderInline(text: string): string {
    let out = text;
    // Orden: primero links, luego strong, em, codespan
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) =>
      this.#renderer.link(t, u)
    );
    out = out.replace(/\*\*(.+?)\*\*/g, (_, t) => this.#renderer.strong(t));
    out = out.replace(/\*(.+?)\*/g, (_, t) => this.#renderer.em(t));
    out = out.replace(/`([^`]+)`/g, (_, t) => this.#renderer.codespan(t));
    return out;
  }

  #flushCodeBlock(): void {
    const state = this.#parserState;
    const code = state.codeBlockLines.join("\n");
    this.#screen.printAbove(
      this.#renderer.codeBlock(code, state.codeBlockLang ?? undefined)
    );
    state.inCodeBlock = false;
    state.codeBlockLang = null;
    state.codeBlockLines = [];
  }
}
```

## Dónde se inyecta

En `index.ts` o donde se construye `DisplayAssistantText`:

```ts
// Hoy:
const display = new DisplayAssistantText(screen);

// Propuesto:
import { AnsiRenderer } from "./tui/markdown/ansi-renderer.js";
const display = new DisplayAssistantText(screen, new AnsiRenderer());
```

El constructor por defecto podría usar `PlainTextRenderer` para mantener compatibilidad.

## Archivos nuevos

```
src/tui/markdown/
  types.ts          → interfaz MarkdownRenderer
  ansi-renderer.ts  → AnsiRenderer (hoy)
  plain-renderer.ts → PlainTextRenderer (sin formato)
```

## Archivos modificados

```
src/tui/components/display-text.ts  → DisplayAssistantText con renderer
```

## Qué NO se modifica

- `Screen` — sigue funcionando igual, `printAbove` / `writeEphemeral` reciben strings ANSI.
- `Runner` — no sabe nada de rendering.
- `index.ts` — solo cambia el `new DisplayAssistantText(screen)` por `new DisplayAssistantText(screen, new AnsiRenderer())`.

## Plan de implementación

1. Crear `src/tui/markdown/types.ts` con la interfaz `MarkdownRenderer`.
2. Crear `src/tui/markdown/ansi-renderer.ts` con `AnsiRenderer`.
3. Crear `src/tui/markdown/plain-renderer.ts` con `PlainTextRenderer` (wrapper que pasa texto sin cambios, útil para tests).
4. Modificar `DisplayAssistantText` para aceptar el renderer en el constructor e implementar `#processLine` y `#renderInline`.
5. Tests unitarios: parser de líneas, renderer ANSI, streaming con chunks cortados.
6. Integrar en `index.ts`.
