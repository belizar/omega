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
    // En modo raw el terminal NO agrega carriage return automático.
    // Escribimos solo \n: el cursor baja una línea y mantiene la columna,
    // lo cual es consistente con getCursorPosition() que cuenta columnas
    // como si cada \n fuera un salto simple (sin \r).
    stdout.write(out);

    renderedRows = out.split("\n").length;

    const cursorPos = component.getCursorPosition?.();
    if (cursorPos) {
      const up = renderedRows - 1 - cursorPos.row;
      if (up > 0) stdout.write(`\x1b[${up}A`);
      // \r asegura columna 0 antes de avanzar a la columna deseada
      stdout.write(`\r\x1b[${cursorPos.col}C`);
    }
  };

  return new Promise((resolve) => {
    // Guardar posición actual (inicio del editor) antes de dibujar
    stdout.write("\x1b7");

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
