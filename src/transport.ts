import { stdin, stdout } from "process";

interface Transport<Tin, Tout> {
  input(): Promise<Tout> | Tout;
  printAssistant(msg: string): void;
  printToolCall(msg: string): void;
  printToolResult(msg: string): void;

  startSpinner(): void;
}

const reset = "\x1b[0m";
const dim = (s: string) => `\x1b[2m${s}${reset}`; // tenue
const cyan = (s: string) => `\x1b[36m${s}${reset}`; // tool calls
const red = (s: string) => `\x1b[31m${s}${reset}`; // errores
const gray = (s: string) => `\x1b[90m${s}${reset}`; // output de tools
const color = (s: string, code: string) => `\x1b[${code}m${s}\x1b[0m`;

class Input {
  #renderedRows: number;
  #promptStr: string;

  constructor() {
    this.#renderedRows = 0;
    this.#promptStr = "> ";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");
    process.on("exit", () => stdin.setRawMode(false));
  }

  read(): Promise<string> {
    return new Promise((resolve, reject) => {
      stdout.write(this.#promptStr);

      let buffer = "";
      const onData = (key: string) => {
        // mostramos cada byte en hexadecimal para "ver" qué llega
        // const bytes = [...key].map((c) => c.charCodeAt(0).toString(16)).join(" ");
        // console.log(`tecla: ${JSON.stringify(key)}  bytes: ${bytes}`);

        if (key === "\u0003") {
          process.exit();
        } // Ctrl-C primero
        else if (key === "\r") {
          stdin.removeListener("data", onData);
          stdout.write("\r\n");
          resolve(buffer);
          return;
        } else if (key === "\x7f") {
          buffer = buffer.slice(0, -1);
        } // backspace
        else if (key === "\x1b[27;2;13~") {
          buffer += "\n";
        } // shift+enter
        else if (key >= " ") {
          buffer += key;
        } // imprimible (las flechas, que empiezan con \x1b, quedan afuera)

        this.render(buffer);
      };

      stdin.on("data", onData);
    });
  }

  private render(buffer: string) {
    if (this.#renderedRows > 0) stdout.write(`\x1b[${this.#renderedRows}A`); // subir lo que dibujé antes
    stdout.write("\r\x1b[0J"); // col 0 + limpiar hasta fin

    stdout.write(this.#promptStr + buffer.replace(/\n/g, "\r\n")); // \n→\r\n (gotcha)

    this.#renderedRows = buffer.split("\n").length - 1; // recordar para la próxima
  }
}

class REPL implements Transport<string, string> {
  constructor() {}
  async input(): Promise<string> {
    return new Input().read();
  }

  printAssistant(msg: string): void {
    stdout.write("\n");
    stdout.write(dim(msg));
  }
  printToolCall(msg: string): void {
    stdout.write("\n");
    stdout.write(cyan(msg));
  }
  printToolResult(msg: string): void {
    stdout.write("\n");
    stdout.write(gray(msg));
  }

  startSpinner(): () => void {
    const colors = ["39", "38", "45", "51", "45", "38"];
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    stdout.write("\n");
    const timer = setInterval(() => {
      const c = colors[i % colors.length];
      const f = frames[i % frames.length];
      stdout.write(`\r${color(`${f} Pensando`, `38;5;${c}`)}`);
      i++;
    }, 100);
    return () => {
      clearInterval(timer);
      stdout.clearLine(0);
      stdout.cursorTo(0);
    };
  }
}

export { REPL, Transport };
