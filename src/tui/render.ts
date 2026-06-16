import { stdin, stdout } from "process";
import { InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";

async function run<T>(component: InputComponent<T>): Promise<T> {
  let renderedRows = 0;

  // Cada draw() sube las filas que ocupó el render anterior, limpia hacia
  // abajo y vuelve a dibujar.  Usamos movimiento explícito (\x1b[N}A) en
  // lugar de \x1b7/\x1b8 (DEC save/restore) porque estos últimos no son
  // confiables en todos los terminales y se corrompen con llamadas anidadas
  // (p.ej. un SelectList abierto desde un comando).

  const draw = () => {
    // Subir hasta el inicio del render anterior y limpiar
    if (renderedRows > 0) {
      stdout.write(`\x1b[${renderedRows}A`);
    }
    stdout.write("\x1b[0J"); // borrar de acá hacia abajo

    const out = component.render();
    stdout.write(out);

    renderedRows = out.split("\n").length;

    const cursorPos = component.getCursorPosition?.();
    if (cursorPos) {
      const up = renderedRows - 1 - cursorPos.row;
      if (up > 0) stdout.write(`\x1b[${up}A`);
      stdout.write(`\r\x1b[${cursorPos.col}C`);
    }
  };

  return new Promise((resolve) => {
    // Buffer para acumular chunks de paste bracketed
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
        // Mover cursor al final del output antes de resolver.
        // draw() dejó el cursor en la posición de edición; lo bajamos
        // al final para que el \r\n siguiente quede debajo del editor.
        const finalOut = component.render();
        const totalLines = finalOut.split("\n").length;
        const cp = component.getCursorPosition?.();
        if (cp) {
          const down = totalLines - 1 - cp.row;
          if (down > 0) stdout.write(`\x1b[${down}B`);
          // Ir al final de la última línea visible
          const lastLine = finalOut.split("\n")[totalLines - 1];
          const colDiff = lastLine.length - cp.col;
          if (colDiff > 0) stdout.write(`\x1b[${colDiff}C`);
        }
        stdout.write("\r\n");
        stdin.removeListener("data", onData);
        resolve(component.getResult());
      }
    };

    const onData = (raw: string) => {
      // Si estamos acumulando un paste bracketed
      if (pasteBuffer !== null) {
        pasteBuffer += raw;
        if (pasteBuffer.includes("\x1b[201~")) {
          // Fin del paste: extraer el contenido entre start y end
          const text = pasteBuffer
            .replace(/^\x1b\[200~/, "")
            .replace(/\x1b\[201~$/, "");
          pasteBuffer = null;
          processKey(text);
        }
        // si no llegó el end, seguimos acumulando
        return;
      }

      // Detectar inicio de paste bracketed (puede venir solo o pegado a contenido)
      if (raw.includes("\x1b[200~")) {
        const idx = raw.indexOf("\x1b[200~");
        // Si hay data antes del inicio del paste, procesarla primero
        if (idx > 0) {
          processKey(raw.slice(0, idx));
        }
        // Empezar a acumular desde el inicio del paste
        pasteBuffer = raw.slice(idx);
        // Si ya contiene el fin, procesarlo completo
        if (pasteBuffer.includes("\x1b[201~")) {
          const text = pasteBuffer
            .replace(/^\x1b\[200~/, "")
            .replace(/\x1b\[201~$/, "");
          pasteBuffer = null;
          processKey(text);
        }
        return;
      }

      // Dato normal (sin paste bracketed en progreso)
      processKey(raw);
    };
    stdin.on("data", onData);
    draw();
  });
}

export { run };
