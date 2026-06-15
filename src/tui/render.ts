import { stdin, stdout } from "process";
import { InputComponent } from "./component.js";
import { decodeKey } from "./decodeKey.js";

async function run<T>(component: InputComponent<T>): Promise<T> {
  let renderedRows = 0; // estado del ciclo de vida de este run

  const draw = () => {
    if (renderedRows > 0) stdout.write(`\x1b[${renderedRows}A`);
    stdout.write("\r\x1b[0J");

    const out = component.render(); // string (puede tener \n)
    stdout.write(out.replace(/\n/g, "\r\n")); // gotcha raw mode

    renderedRows = out.split("\n").length - 1;
  };

  return new Promise((resolve) => {
    const onData = (raw: string) => {
      const key = decodeKey(raw);
      if (key.type === "ctrl" && key.key === "c") {
        stdin.removeListener("data", onData);
        process.exit(0); // (con el exit handler restaurando raw mode)
      }
      component.handleKey(key);
      draw();
      if (component.isDone()) {
        stdin.removeListener("data", onData);
        resolve(component.getResult());
      }
    };
    stdin.on("data", onData);
    draw();
  });
}

export { run };
