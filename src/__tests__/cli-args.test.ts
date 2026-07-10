import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../cli-args.js";

describe("parseCliArgs", () => {
  it("sin flags → TUI (headless=false)", () => {
    expect(parseCliArgs([])).toEqual({
      headless: false,
      prompt: null,
      format: "json",
      model: null,
      temp: null,
      serve: false,
      serveCmd: null,
      mc: false,
      port: 4477,
    });
  });

  it("-p con valor inline → headless, prompt, json por default", () => {
    expect(parseCliArgs(["-p", "arreglá el test"])).toEqual({
      headless: true,
      prompt: "arreglá el test",
      format: "json",
      model: null,
      temp: null,
      serve: false,
      serveCmd: null,
      mc: false,
      port: 4477,
    });
  });

  it("`mc` activa el mission-control cliente", () => {
    expect(parseCliArgs(["mc"])).toMatchObject({ mc: true, serve: false, headless: false });
    expect(parseCliArgs(["mc", "--port", "5000"]).port).toBe(5000);
  });

  it("--temp parsea un número (incluido 0)", () => {
    expect(parseCliArgs(["-p", "x", "--temp", "0"]).temp).toBe(0);
    expect(parseCliArgs(["-p", "x", "--temp", "0.7"]).temp).toBe(0.7);
    expect(parseCliArgs(["-p", "x"]).temp).toBeNull();
  });

  it("--serve activa el frontend web (puerto default 4477)", () => {
    expect(parseCliArgs(["--serve"])).toMatchObject({ serve: true, serveCmd: null, port: 4477, headless: false });
  });

  it("`serve` (sin --) también arranca el daemon", () => {
    expect(parseCliArgs(["serve"])).toMatchObject({ serve: true, serveCmd: null });
  });

  it("`serve stop` / `serve status` setean el subcomando de control", () => {
    expect(parseCliArgs(["serve", "stop"])).toMatchObject({ serve: true, serveCmd: "stop" });
    expect(parseCliArgs(["serve", "status"])).toMatchObject({ serve: true, serveCmd: "status" });
    expect(parseCliArgs(["serve", "stop", "--port", "5000"])).toMatchObject({ serveCmd: "stop", port: 5000 });
  });

  it("`serve` con un token cualquiera NO lo toma como subcomando", () => {
    // Solo stop/status son subcomandos; cualquier otra cosa se ignora.
    expect(parseCliArgs(["serve", "foo"])).toMatchObject({ serve: true, serveCmd: null });
  });

  it("--port cambia el puerto", () => {
    expect(parseCliArgs(["--serve", "--port", "8080"]).port).toBe(8080);
  });

  it("--model setea el override de modelo", () => {
    expect(parseCliArgs(["-p", "x", "--model", "anthropic/claude-opus-4-8"]).model).toBe(
      "anthropic/claude-opus-4-8",
    );
  });

  it("--model sin valor no rompe (queda null)", () => {
    expect(parseCliArgs(["-p", "x", "--model"]).model).toBeNull();
  });

  it("--print es alias de -p", () => {
    expect(parseCliArgs(["--print", "hola"]).prompt).toBe("hola");
  });

  it("--format text cambia el formato", () => {
    expect(parseCliArgs(["-p", "hola", "--format", "text"]).format).toBe("text");
  });

  it("-p sin valor → prompt null (leer de stdin)", () => {
    expect(parseCliArgs(["-p"])).toMatchObject({ headless: true, prompt: null });
  });

  it("-p - → prompt null (stdin explícito)", () => {
    expect(parseCliArgs(["-p", "-"])).toMatchObject({ headless: true, prompt: null });
  });

  it("-p seguido de otro flag → no consume el flag como prompt", () => {
    const r = parseCliArgs(["-p", "--format", "text"]);
    expect(r.prompt).toBeNull();
    expect(r.format).toBe("text");
  });

  it("--format inválido se ignora (queda json)", () => {
    expect(parseCliArgs(["-p", "x", "--format", "xml"]).format).toBe("json");
  });
});
