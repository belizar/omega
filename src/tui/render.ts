import { stdin, stdout } from "process";
import { InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";

async function run<T>(component: InputComponent<T>): Promise<T> {
  let renderedRows = 0;

  const hasCursor = typeof component.getCursorPosition === "function";

  const draw = () => {
    if (hasCursor) {
      stdout.write("\x1b8");       // restaurar cursor al inicio del componente
      stdout.write("\x1b[0J");     // limpiar hacia abajo
    } else {
      stdout.write("\x1b[H");      // ir a home (alternate screen)
      stdout.write("\x1b[J");      // limpiar desde cursor hacia abajo
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
    } else {
      // Alternate screen buffer: evita problemas de scroll cuando la
      // lista es mas larga que el espacio disponible en el viewport.
      stdout.write("\x1b[?1049h"); // entrar a alternate screen
      stdout.write("\x1b[?25l");   // ocultar cursor
    }

    let pasteBuffer: string | null = null;

    const processKey = (keyStr: string) => {
      const key = decodeKey(keyStr);
      if (key.type === "ctrl" && key.key === "c") {
        // Si estamos en alternate screen, salir antes de matar
        if (!hasCursor) {
          stdout.write("\x1b[?25h");
          stdout.write("\x1b[?1049l");
        }
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
          // Salir del alternate screen, volver al buffer principal
          stdout.write("\x1b[?25h");   // mostrar cursor
          stdout.write("\x1b[?1049l"); // salir de alternate screen
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