import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../cli-args.js";

describe("parseCliArgs", () => {
  it("sin flags → TUI (headless=false)", () => {
    expect(parseCliArgs([])).toEqual({
      headless: false,
      prompt: null,
      format: "json",
      model: null,
    });
  });

  it("-p con valor inline → headless, prompt, json por default", () => {
    expect(parseCliArgs(["-p", "arreglá el test"])).toEqual({
      headless: true,
      prompt: "arreglá el test",
      format: "json",
      model: null,
    });
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
