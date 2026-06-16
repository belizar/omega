import { stdin, stdout } from "process";
import { InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";

async function run<T>(component: InputComponent<T>): Promise<T> {
  let renderedRows = 0;
  const hasCursor = typeof component.getCursorPosition === "function";

  const draw = () => {
    stdout.write("\x1b8");   // volver al inicio del componente
    stdout.write("\x1b[0J"); // limpiar hacia abajo

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
    // Guardar posicion actual como inicio del componente.
    stdout.write("\x1b7");

    if (!hasCursor) {
      stdout.write("\x1b[?25l"); // ocultar cursor en listas
    }

    let pasteBuffer: string | null = null;

    const processKey = (keyStr: string) => {
      const key = decodeKey(keyStr);
      if (key.type === "ctrl" && key.key === "c") {
        if (!hasCursor) stdout.write("\x1b[?25h");
        stdin.removeListener("data", onData);
        disableRawMode();
        process.exit(0);
      }
      component.handleKey(key);
      draw();
      if (component.isDone()) {
        // Limpiar el output del componente y dejar cursor debajo
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
          // Sin cursor: mostrar cursor, dejar output en pantalla
          // y bajar una linea para que el siguiente componente
          // (LineEditor) arranque debajo.
          stdout.write("\x1b[?25h");
          stdout.write("\r\n");
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