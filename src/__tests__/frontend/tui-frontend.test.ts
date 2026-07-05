import { describe, it, expect, vi, beforeEach } from "vitest";
import { TUIFrontend } from "../../frontend/tui-frontend.js";
import type { RunnerEvent } from "../../runner.js";

/** Stubs mínimos: registran las llamadas sin tocar la terminal real. */
function makeDeps(verbose = false) {
  const screen = { redrawLive: vi.fn(), printAbove: vi.fn(), askUser: vi.fn().mockResolvedValue("respuesta"), setAbortController: vi.fn(), clearAbortController: vi.fn() };
  const spinner = { start: vi.fn(), stop: vi.fn() };
  const assistantText = { display: vi.fn(), displayStream: vi.fn(), endStream: vi.fn() };
  const toolCallText = { call: vi.fn() };
  const toolResultText = { result: vi.fn() };
  const front = new TUIFrontend({
    screen: screen as any,
    spinner: spinner as any,
    assistantText: assistantText as any,
    toolCallText: toolCallText as any,
    toolResultText: toolResultText as any,
    lineEditor: {} as any,
    ctx: {} as any,
    modals: {} as any,
    getVerbose: () => verbose,
  });
  return { front, screen, spinner, assistantText, toolCallText, toolResultText };
}

describe("TUIFrontend (seam)", () => {
  let d: ReturnType<typeof makeDeps>;
  beforeEach(() => { d = makeDeps(); });

  it("turnStarted prende el spinner", () => {
    d.front.turnStarted();
    expect(d.spinner.start).toHaveBeenCalledOnce();
  });

  it("text_stream: para el spinner y streamea", () => {
    d.front.handleEvent({ type: "text_stream", text: "hola" });
    expect(d.spinner.stop).toHaveBeenCalledOnce();
    expect(d.assistantText.displayStream).toHaveBeenCalledWith("hola");
  });

  it("text_stream_end cierra el stream", () => {
    d.front.handleEvent({ type: "text_stream_end" });
    expect(d.assistantText.endStream).toHaveBeenCalledOnce();
  });

  it("text: para el spinner y muestra", () => {
    d.front.handleEvent({ type: "text", text: "listo" });
    expect(d.spinner.stop).toHaveBeenCalledOnce();
    expect(d.assistantText.display).toHaveBeenCalledWith("listo");
  });

  it("tool_use: para el spinner y renderiza la call con verbose", () => {
    d.front.handleEvent({ type: "tool_use", name: "bash", input: { command: "ls" } });
    expect(d.spinner.stop).toHaveBeenCalledOnce();
    expect(d.toolCallText.call).toHaveBeenCalledWith("bash", { command: "ls" }, false);
  });

  it("tool_result: renderiza y re-prende el spinner", () => {
    d.front.handleEvent({ type: "tool_result", output: "out", rawOutput: "raw", isError: true });
    expect(d.toolResultText.result).toHaveBeenCalledWith("out", false, "raw", true);
    expect(d.spinner.start).toHaveBeenCalledOnce();
  });

  it("state NO se renderiza en el frontend (lo consume el loop)", () => {
    d.front.handleEvent({ type: "state", message: { role: "assistant", content: [] } } as RunnerEvent);
    expect(d.spinner.stop).not.toHaveBeenCalled();
    expect(d.assistantText.display).not.toHaveBeenCalled();
    expect(d.toolCallText.call).not.toHaveBeenCalled();
  });

  it("turnEnded para el spinner y redibuja", () => {
    d.front.turnEnded();
    expect(d.spinner.stop).toHaveBeenCalledOnce();
    expect(d.screen.redrawLive).toHaveBeenCalledOnce();
  });

  it("askUser: para el spinner, pregunta, re-prende y devuelve la respuesta", async () => {
    const answer = await d.front.askUser("¿seguís?");
    expect(d.spinner.stop).toHaveBeenCalledOnce();
    expect(d.screen.askUser).toHaveBeenCalledWith("¿seguís?");
    expect(d.spinner.start).toHaveBeenCalledOnce();
    expect(answer).toBe("respuesta");
  });

  it("notify imprime arriba (incluye el texto)", () => {
    d.front.notify("métricas");
    expect(d.screen.printAbove).toHaveBeenCalledOnce();
    expect(d.screen.printAbove.mock.calls[0][0]).toContain("métricas");
  });

  it("abort controller: delega en el screen", () => {
    const c = new AbortController();
    d.front.setAbortController(c);
    d.front.clearAbortController();
    expect(d.screen.setAbortController).toHaveBeenCalledWith(c);
    expect(d.screen.clearAbortController).toHaveBeenCalledOnce();
  });

  it("getVerbose se lee dinámicamente en cada evento", () => {
    let verbose = false;
    const screen = { setAbortController: vi.fn() } as any;
    const spinner = { start: vi.fn(), stop: vi.fn() } as any;
    const toolCallText = { call: vi.fn() } as any;
    const front = new TUIFrontend({
      screen, spinner,
      assistantText: { display: vi.fn(), displayStream: vi.fn(), endStream: vi.fn() } as any,
      toolCallText,
      toolResultText: { result: vi.fn() } as any,
      lineEditor: {} as any,
      ctx: {} as any,
      modals: {} as any,
      getVerbose: () => verbose,
    });
    front.handleEvent({ type: "tool_use", name: "read", input: {} });
    verbose = true;
    front.handleEvent({ type: "tool_use", name: "read", input: {} });
    expect(toolCallText.call.mock.calls[0][2]).toBe(false);
    expect(toolCallText.call.mock.calls[1][2]).toBe(true);
  });
});
