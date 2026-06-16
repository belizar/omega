import { stdin, stdout } from "process";
import { InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";

/** Profundidad de llamadas anidadas a run(). Solo la más externa usa \x1b7. */
let runDepth = 0;

async function run<T>(component: InputComponent<T>): Promise<T> {
  const isOuter = runDepth === 0;
  runDepth++;

  let renderedRows = 0;

  const draw = () => {
    if (isOuter) {
      // Modo externo (LineEditor): save/restore cursor
      stdout.write("\x1b8");
      stdout.write("\x1b[0J");
    } else {
      // Modo anidado (SelectList): movimiento explícito.
      // El cursor siempre está al final del render del componente
      // (sin getCursorPosition no lo movemos).
      if (renderedRows > 0) {
        stdout.write(`\x1b[${renderedRows}A`);
      }
      stdout.write("\x1b[0J");
    }

    const out = component.render();
    stdout.write(out);
    renderedRows = out.split("\n").length;

    const cp = component.getCursorPosition?.();
    if (cp) {
      const up = renderedRows - 1 - cp.row;
      if (up > 0) stdout.write(`\x1b[${up}A`);
      stdout.write(`\r\x1b[${cp.col}C`);
    }
  };

  return new Promise((resolve) => {
    if (isOuter) {
      stdout.write("\x1b7"); // guardar posición inicial
    }

    let pasteBuffer: string | null = null;

    const processKey = (keyStr: string) => {
      const key = decodeKey(keyStr);
      if (key.type === "ctrl" && key.key === "c") {
        stdin.removeListener("data", onData);
        disableRawMode();
        process.exit(0);
      }
      component.handleKey(key);
      draw();
      if (component.isDone()) {
        if (isOuter) {
          // Limpiar y dejar cursor debajo
          const cp = component.getCursorPosition?.();
          if (cp) {
            const finalOut = component.render();
            const totalLines = finalOut.split("\n").length;
            const down = totalLines - 1 - cp.row;
            if (down > 0) stdout.write(`\x1b[${down}B`);
            const lastLine = finalOut.split("\n")[totalLines - 1];
            const colDiff = lastLine.length - cp.col;
            if (colDiff > 0) stdout.write(`\x1b[${colDiff}C`);
            stdout.write("\r\n");
          } else {
            stdout.write("\x1b8");
            stdout.write("\x1b[0J");
          }
        } else {
          // Anidado: limpiar area y restaurar
          if (renderedRows > 0) {
            stdout.write(`\x1b[${renderedRows}A`);
          }
          stdout.write("\x1b[0J");
        }

        stdin.removeListener("data", onData);
        runDepth--;
        resolve(component.getResult());
      }
    };

    const onData = (raw: string) => {
      if (pasteBuffer !== null) {
        pasteBuffer += raw;
        if (pasteBuffer.includes("\x1b[201~")) {
          const text = pasteBuffer
            .replace(/^\x1b\[200~/, "")
            .replace(/\x1b\[201~$/, "");
          pasteBuffer = null;
          processKey(text);
        }
        return;
      }

      if (raw.includes("\x1b[200~")) {
        const idx = raw.indexOf("\x1b[200~");
        if (idx > 0) {
          processKey(raw.slice(0, idx));
        }
        pasteBuffer = raw.slice(idx);
        if (pasteBuffer.includes("\x1b[201~")) {
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