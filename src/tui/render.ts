import { stdin, stdout } from "process";
import { InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";
import { disableRawMode } from "./terminal.js";

async function run<T>(component: InputComponent<T>): Promise<T> {
  let renderedRows = 0;

  // Guardamos la posición absoluta donde empieza el editor.
  // \x1b7 = DECSC (save cursor), \x1b8 = DECRC (restore cursor).
  // Esto es crítico: entre run() y run() el loop principal escribe output
  // del asistente, así que un \x1b[A relativo no sabe dónde está el editor.
  // Con save/restore, cada draw() vuelve exactamente al inicio del editor.

  const draw = () => {
    // Restaurar cursor a la posición guardada (inicio del editor)
    stdout.write("\x1b8");
    stdout.write("\x1b[0J"); // borrar de acá hacia abajo

    const out = component.render();
    stdout.write(out.replace(/\n/g, "\r\n"));

    renderedRows = out.split("\n").length;

    const cursorPos = component.getCursorPosition?.();
    if (cursorPos) {
      const up = renderedRows - 1 - cursorPos.row;
      if (up > 0) stdout.write(`\x1b[${up}A`);
      stdout.write(`\r\x1b[${cursorPos.col}C`);
    }
  };

  return new Promise((resolve) => {
    // Guardar posición actual (inicio del editor) antes de dibujar
    stdout.write("\x1b7");

    const onData = (raw: string) => {
      const key = decodeKey(raw);
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
    stdin.on("data", onData);
    draw();
  });
}

export { run };
