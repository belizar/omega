import { describe, it, expect, vi } from "vitest";

// dispatchCommand se importa como módulo en tui-frontend; lo mockeamos para que
// nunca matchee un comando (así el input fluye como mensaje/exit).
vi.mock("../../commands/index.js", () => ({
  // dispatchCommand devuelve una unión discriminada (desde #86), no un boolean.
  dispatchCommand: vi.fn().mockResolvedValue({ kind: "not-command" }),
  modalCommandsMap: {},
  // listCommands lo usa el Prompt para el menú de `/` (desde #87).
  listCommands: vi.fn().mockReturnValue([]),
}));

import { TUIFrontend } from "../../frontend/frontends/tui-frontend.js";

function makeFront(overrides: { screen?: any; lineEditor?: any } = {}) {
  const screen = {
    takeQueue: vi.fn().mockReturnValue([]),
    takePendingLine: vi.fn().mockReturnValue(""),
    printAbove: vi.fn(),
    printBlankLine: vi.fn(),
    readLine: vi.fn(),
    ...overrides.screen,
  };
  const lineEditor = {
    renderEchoOf: vi.fn().mockReturnValue("echo"),
    renderEcho: vi.fn().mockReturnValue("echo"),
    getResult: vi.fn().mockReturnValue(""),
    addToHistory: vi.fn(),
    reset: vi.fn(),
    setBuffer: vi.fn(),
    consumePendingImages: vi.fn().mockReturnValue([]),
    ...overrides.lineEditor,
  };
  const front = new TUIFrontend({
    screen: screen as any,
    spinner: { start: vi.fn(), stop: vi.fn() } as any,
    assistantText: {} as any,
    toolCallText: {} as any,
    toolResultText: {} as any,
    lineEditor: lineEditor as any,
    ctx: {} as any,
    modals: {} as any,
    heroInfo: {} as any,
    getVerbose: () => false,
  });
  return { front, screen, lineEditor };
}

describe("TUIFrontend.nextInput — type-ahead + interactivo", () => {
  it("devuelve el mensaje encolado (type-ahead) SIN leer una línea nueva", async () => {
    const { front, screen, lineEditor } = makeFront({
      screen: {
        takeQueue: vi.fn().mockReturnValueOnce(["encolado"]).mockReturnValue([]),
      },
    });
    const inp = await front.nextInput();
    expect(inp).toEqual({ kind: "message", text: "encolado", pastedImages: [] });
    expect(lineEditor.renderEchoOf).toHaveBeenCalledWith("encolado");
    expect(screen.readLine).not.toHaveBeenCalled();
  });

  it("batchea todos los encolados en un solo mensaje (concatenados)", async () => {
    const { front, screen } = makeFront({
      screen: {
        takeQueue: vi.fn().mockReturnValueOnce(["a", "b"]).mockReturnValue([]),
      },
    });
    expect(await front.nextInput()).toMatchObject({
      kind: "message",
      text: "a\nb",
    });
    expect(screen.readLine).not.toHaveBeenCalled(); // se procesó el batch, no leyó línea
  });

  it("con cola vacía, lee del editor y devuelve el mensaje", async () => {
    const { front, screen } = makeFront({
      screen: { readLine: vi.fn().mockResolvedValue({ kind: "text", text: "vivo" }) },
    });
    const inp = await front.nextInput();
    expect(screen.readLine).toHaveBeenCalledOnce();
    expect(inp).toEqual({ kind: "message", text: "vivo", pastedImages: [] });
  });

  it("un comando modal devuelve none (sin eco de input)", async () => {
    const { front } = makeFront({
      screen: { readLine: vi.fn().mockResolvedValue({ kind: "modal", message: "ok" }) },
    });
    expect(await front.nextInput()).toEqual({ kind: "none" });
  });

  it("'exit' devuelve exit", async () => {
    const { front } = makeFront({
      screen: { readLine: vi.fn().mockResolvedValue({ kind: "text", text: "exit" }) },
    });
    expect(await front.nextInput()).toEqual({ kind: "exit" });
  });

  it("precarga la línea a medio tipear antes de leer", async () => {
    const { front, lineEditor } = makeFront({
      screen: {
        takePendingLine: vi.fn().mockReturnValue("a-medias"),
        readLine: vi.fn().mockResolvedValue({ kind: "text", text: "final" }),
      },
    });
    await front.nextInput();
    expect(lineEditor.setBuffer).toHaveBeenCalledWith("a-medias");
  });
});
