import { stdin, stdout } from "process";
import { CursorPosition, InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";

async function run<T>(component: InputComponent<T>): Promise<T> {
  let renderedRows = 0;
  let lastCursor: CursorPosition | null = null;

  const draw = () => {
    // 1. Si el cursor está en el medio del render (LineEditor), bajarlo
    //    al final para que renderedRows sea confiable.
    if (lastCursor && renderedRows > 0) {
      const down = renderedRows - 1 - lastCursor.row;
      if (down > 0) stdout.write(`\x1b[${down}B`);
    }

    // 2. Subir al inicio del render anterior y limpiar hacia abajo
    if (renderedRows > 0) {
      stdout.write(`\x1b[${renderedRows}A`);
    }
    stdout.write("\x1b[0J");

    // 3. Renderizar
    const out = component.render();
    stdout.write(out);
    renderedRows = out.split("\n").length;

    // 4. Posicionar cursor (si el componente lo pide)
    const cp = component.getCursorPosition?.();
    if (cp) {
      const up = renderedRows - 1 - cp.row;
      if (up > 0) stdout.write(`\x1b[${up}A`);
      stdout.write(`\r\x1b[${cp.col}C`);
      lastCursor = cp;
    } else {
      lastCursor = null;
    }
  };

  return new Promise((resolve) => {
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
        // Limpiar el output del componente
        if (lastCursor && renderedRows > 0) {
          const down = renderedRows - 1 - lastCursor.row;
          if (down > 0) stdout.write(`\x1b[${down}B`);
        }
        if (renderedRows > 0) {
          stdout.write(`\x1b[${renderedRows}A`);
        }
        stdout.write("\x1b[0J");
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