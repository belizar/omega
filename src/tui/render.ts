import { stdin, stdout } from "process";
import { InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";

async function run<T>(component: InputComponent<T>): Promise<T> {
  let renderedRows = 0;

  // Estrategia de redibujo:
  //
  // A) Con cursor (LineEditor): \x1b7 / \x1b8 (DEC save/restore).
  //    El render es chico (3 líneas), nunca scrollea el terminal, así que
  //    save/restore es 100% confiable y el cursor se posiciona exactamente.
  //
  // B) Sin cursor (SelectList, etc.): movimiento explícito \x1b[N}A.
  //    El render puede tener muchas líneas y causar scroll, lo cual rompe
  //    \x1b7/\x1b8. Pero como el cursor siempre queda al final del render
  //    (nadie llama a getCursorPosition), renderedRows es exacto y podemos
  //    subir limpiamente.

  const hasCursor = typeof component.getCursorPosition === "function";

  const draw = () => {
    if (hasCursor) {
      stdout.write("\x1b8");
      stdout.write("\x1b[0J");
    } else {
      if (renderedRows > 0) {
        stdout.write(`\x1b[${renderedRows}A`);
      }
      stdout.write("\x1b[0J");
    }

    const out = component.render();
    stdout.write(out);
    renderedRows = out.split("\n").length;

    if (hasCursor) {
      const cp = component.getCursorPosition!();
      const up = renderedRows - 1 - cp.row;
      if (up > 0) stdout.write(`\x1b[${up}A`);
      stdout.write(`\r\x1b[${cp.col}C`);
    }
  };

  return new Promise((resolve) => {
    if (hasCursor) {
      stdout.write("\x1b7"); // guardar posición inicial del componente
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
        if (hasCursor) {
          const finalOut = component.render();
          const totalLines = finalOut.split("\n").length;
          const cp = component.getCursorPosition!();
          const down = totalLines - 1 - cp.row;
          if (down > 0) stdout.write(`\x1b[${down}B`);
          const lastLine = finalOut.split("\n")[totalLines - 1];
          const colDiff = lastLine.length - cp.col;
          if (colDiff > 0) stdout.write(`\x1b[${colDiff}C`);
          stdout.write("\r\n");
        } else {
          // Sin cursor: limpiar output y volver arriba
          if (renderedRows > 0) {
            stdout.write(`\x1b[${renderedRows}A`);
          }
          stdout.write("\x1b[0J");
        }

        stdin.removeListener("data", onData);
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