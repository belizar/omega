import { stdin, stdout } from "process";
import * as readline from "readline/promises";
import { Interface } from "readline/promises";

interface Transport<Tin, Tout> {
  input(): Promise<Tout> | Tout;
  print(mesage: Tin): void;
  close(): void;
}

class REPL implements Transport<string, string> {
  #rl: Interface;
  constructor() {
    this.#rl = readline.createInterface({ input: stdin, output: stdout });
  }

  async input(): Promise<string> {
    const input = await this.#rl.question("> ");
    return input;
  }

  print(message: string) {
    stdout.write(message);
    stdout.write("\n");
  }

  close() {
    this.#rl.close();
  }
}

export { REPL, Transport };
