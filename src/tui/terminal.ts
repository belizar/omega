// tui/terminal.ts
import { stdin, stdout } from "process";

export function enableRawMode() {
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf-8");
  stdout.write("\x1b[?2004h"); // bracketed paste on
  process.on("exit", disableRawMode); // restaurar al salir
}

export function disableRawMode() {
  stdin.setRawMode(false);
  stdout.write("\x1b[?2004l"); // bracketed paste off
}
