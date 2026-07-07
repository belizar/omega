import { describe, it, expect } from "vitest";
import { Prompt } from "../../tui/components/prompt.js";
import { LineEditor } from "../../tui/components/line-editor.js";
import { Context } from "../../app-context.js";
import { CommandListItem } from "../../commands/index.js";

const COMMANDS: CommandListItem[] = [
  { name: "/clear", description: "limpia" },
  { name: "/help", description: "ayuda" },
  { name: "/model", description: "modelo" },
];

function makePrompt(commands = COMMANDS): Prompt {
  return new Prompt({
    editor: new LineEditor(),
    ctx: {} as unknown as Context, // solo se usa para modales; no hay
    modals: {},
    commands,
  });
}

function type(prompt: Prompt, text: string): void {
  for (const ch of text) prompt.handleKey({ type: "char", value: ch });
}

describe("Prompt — menú de slash-commands", () => {
  it("abre el menú al tipear '/' y lista todos los comandos", () => {
    const p = makePrompt();
    type(p, "/");
    const out = p.render();
    expect(out).toContain("/clear");
    expect(out).toContain("/help");
    expect(out).toContain("/model");
    expect(p.isDone()).toBe(false);
  });

  it("filtra la lista según el prefijo tipeado", () => {
    const p = makePrompt();
    type(p, "/cl");
    const out = p.render();
    expect(out).toContain("/clear");
    expect(out).not.toContain("/help");
    expect(out).not.toContain("/model");
  });

  it("Enter elige el comando resaltado y lo submitea", () => {
    const p = makePrompt();
    type(p, "/cl");
    p.handleKey({ type: "enter" });
    expect(p.isDone()).toBe(true);
    const result = p.getResult();
    expect(result).toEqual({ kind: "submit", text: "/clear" });
  });

  it("navega con flechas y Enter elige el resaltado", () => {
    const p = makePrompt();
    type(p, "/"); // los tres, resaltado en /clear
    p.handleKey({ type: "down" }); // → /help
    p.handleKey({ type: "enter" });
    expect(p.getResult()).toEqual({ kind: "submit", text: "/help" });
  });

  it("Tab completa el comando al buffer sin submitear (para args)", () => {
    const p = makePrompt();
    type(p, "/mo");
    p.handleKey({ type: "tab" });
    expect(p.isDone()).toBe(false);
    expect(p.render()).toContain("/model ");
  });

  it("Escape cierra el menú y deja el buffer intacto", () => {
    const p = makePrompt();
    type(p, "/he");
    p.handleKey({ type: "escape" });
    expect(p.isDone()).toBe(false);
    // El menú ya no está; sigue editable y al dar Enter submitea el literal.
    p.handleKey({ type: "enter" });
    expect(p.getResult()).toEqual({ kind: "submit", text: "/he" });
  });

  it("un espacio (inicio de args) cierra el menú", () => {
    const p = makePrompt();
    type(p, "/help ");
    p.handleKey({ type: "enter" });
    expect(p.getResult()).toEqual({ kind: "submit", text: "/help" });
  });

  it("no abre menú si el prefijo no matchea ningún comando", () => {
    const p = makePrompt();
    type(p, "/zzz");
    expect(p.render()).not.toContain("/clear");
    p.handleKey({ type: "enter" });
    expect(p.getResult()).toEqual({ kind: "submit", text: "/zzz" });
  });
});
