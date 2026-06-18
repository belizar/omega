// tui/terminal.ts
import { stdin, stdout } from "process";

let rawModeEnabled = false;

export function enableRawMode() {
  if (rawModeEnabled) return;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf-8");
  stdout.write("\x1b[?2004h"); // bracketed paste on
  rawModeEnabled = true;

  // Restaurar al salir normalmente
  process.on("exit", disableRawMode);

  // Restaurar ante SIGTERM. SIGINT se maneja en el Screen/runner para
  // interrumpir al agente sin matar el proceso.
  process.on("SIGTERM", () => {
    disableRawMode();
    process.exit(1);
  });
}

export function disableRawMode() {
  if (!rawModeEnabled) return;
  stdin.setRawMode(false);
  stdout.write("\x1b[?2004l"); // bracketed paste off
  stdout.write("\r\n");        // dejar el cursor en línea nueva
  rawModeEnabled = false;
}

export function isRawModeEnabled() {
  return rawModeEnabled;
}
