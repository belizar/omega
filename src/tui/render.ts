import { stdin, stdout } from "process";
import { InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";

// ── Secuencias de escape ANSI ─────────────────────────────────────────

// Control de cursor
const CSI = "\x1b[";                          // Control Sequence Introducer
const CUU = (n: number) => `${CSI}${n}A`;     // Cursor Up n rows
const CUD = (n: number) => `${CSI}${n}B`;     // Cursor Down n rows
const CUF = (n: number) => `${CSI}${n}C`;     // Cursor Forward n cols
const ED0 = `${CSI}0J`;                       // Erase Display: cursor to end
const SCP = "\x1b7";                          // Save Cursor Position (DECSC)
const RCP = "\x1b8";                          // Restore Cursor Position (DECRC)
const CR  = "\r";                             // Carriage Return
const LF  = "\n";                             // Line Feed

// Visibilidad del cursor
const CURSOR_HIDE = `${CSI}?25l`;             // DECTCEM hide cursor
const CURSOR_SHOW = `${CSI}?25h`;             // DECTCEM show cursor

// Bracketed paste
const PASTE_START = "\x1b[200~";
const PASTE_END   = "\x1b[201~";

// ── run() ─────────────────────────────────────────────────────────────

async function run<T>(component: InputComponent<T>): Promise<T> {
  let renderedRows = 0;
  const hasCursor = typeof component.getCursorPosition === "function";

  const draw = () => {
    stdout.write(RCP);     // volver al inicio guardado del componente
    stdout.write(ED0);     // limpiar de ese punto hacia abajo

    const out = component.render();
    stdout.write(out);
    renderedRows = out.split("\n").length;

    if (hasCursor) {
      const cp = component.getCursorPosition!();
      const up = renderedRows - 1 - cp.row;
      if (up > 0) stdout.write(CUU(up));
      stdout.write(CR + CUF(cp.col));
    }
  };

  return new Promise((resolve) => {
    stdout.write(SCP);     // guardar posicion como inicio del componente

    if (!hasCursor) {
      stdout.write(CURSOR_HIDE);
    }

    let pasteBuffer: string | null = null;

    const processKey = (keyStr: string) => {
      const key = decodeKey(keyStr);
      if (key.type === "ctrl" && key.key === "c") {
        if (!hasCursor) stdout.write(CURSOR_SHOW);
        stdin.removeListener("data", onData);
        disableRawMode();
        process.exit(0);
      }
      component.handleKey(key);
      draw();
      if (component.isDone()) {
        if (hasCursor) {
          // Bajar cursor al final del render y emitir \r\n debajo
          const finalOut = component.render();
          const totalLines = finalOut.split("\n").length;
          const cp = component.getCursorPosition!();
          const down = totalLines - 1 - cp.row;
          if (down > 0) stdout.write(CUD(down));
          const lastLine = finalOut.split("\n")[totalLines - 1];
          const colDiff = lastLine.length - cp.col;
          if (colDiff > 0) stdout.write(CUF(colDiff));
          stdout.write(CR + LF);
        } else {
          // Componente sin cursor: mostrar cursor y dejar output en pantalla
          stdout.write(CURSOR_SHOW);
          stdout.write(CR + LF);
        }

        stdin.removeListener("data", onData);
        resolve(component.getResult());
      }
    };

    const onData = (raw: string) => {
      if (pasteBuffer !== null) {
        pasteBuffer += raw;
        if (pasteBuffer.includes(PASTE_END)) {
          const text = pasteBuffer
            .replace(/^\x1b\[200~/, "")
            .replace(/\x1b\[201~$/, "");
          pasteBuffer = null;
          processKey(text);
        }
        return;
      }

      if (raw.includes(PASTE_START)) {
        const idx = raw.indexOf(PASTE_START);
        if (idx > 0) {
          processKey(raw.slice(0, idx));
        }
        pasteBuffer = raw.slice(idx);
        if (pasteBuffer.includes(PASTE_END)) {
          const text = pasteBuffer
            .replace(/^\x1b\[200~/, "")
            .replace(/\x1b\[201~$/, "");
          pasteBuffer = null;
          processKey(text);
        }
        return;
      }

      processKey(raw);
    };
    stdin.on("data", onData);
    draw();
  });
}

export { run };