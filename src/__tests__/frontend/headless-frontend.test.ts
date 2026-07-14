import { describe, it, expect } from "vitest";
import { HeadlessFrontend } from "../../frontend/frontends/headless-frontend.js";
import { TurnMetrics } from "../../frontend/frontends/frontend.js";

function makeFront(format: "json" | "text" = "json", prompt = "hacé algo") {
  const out: string[] = [];
  const err: string[] = [];
  const front = new HeadlessFrontend({
    prompt,
    format,
    model: "test-model",
    sessionId: "sess-123",
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  // Parsea las líneas NDJSON emitidas a stdout.
  const events = () =>
    out.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { front, out, err, events };
}

const METRICS: TurnMetrics = {
  model: "test/model-x",
  steps: 4,
  contextTokens: 100,
  toolCalls: 2,
  inputTokens: 500,
  outputTokens: 200,
  turnCost: 0.03,
  totalCost: 0.05,
  durationMs: 1500,
  toolErrors: 0,
  rereads: [],
};

describe("HeadlessFrontend — nextInput (one-shot)", () => {
  it("entrega el prompt una vez y después pide exit", async () => {
    const { front } = makeFront("json", "el prompt");
    expect(await front.nextInput()).toEqual({
      kind: "message",
      text: "el prompt",
      pastedImages: [],
    });
    expect(await front.nextInput()).toEqual({ kind: "exit" });
    expect(await front.nextInput()).toEqual({ kind: "exit" });
  });
});

describe("HeadlessFrontend — json", () => {
  it("start emite un evento start con session y model", () => {
    const { front, events } = makeFront("json");
    front.start();
    expect(events()[0]).toEqual({ type: "start", session: "sess-123", model: "test-model" });
  });

  it("coalesce los deltas de streaming en un evento assistant", () => {
    const { front, events } = makeFront("json");
    front.turnStarted();
    front.handleEvent({ type: "text_stream", text: "Ho" });
    front.handleEvent({ type: "text_stream", text: "la" });
    front.handleEvent({ type: "text_stream_end" });
    expect(events()).toEqual([{ type: "assistant", text: "Hola" }]);
  });

  it("emite tool_use y tool_result", () => {
    const { front, events } = makeFront("json");
    front.turnStarted();
    front.handleEvent({ type: "tool_use", name: "bash", input: { command: "ls" } });
    front.handleEvent({ type: "tool_result", output: "a.ts", isError: false });
    expect(events()).toEqual([
      { type: "tool_use", name: "bash", input: { command: "ls" } },
      { type: "tool_result", isError: false, output: "a.ts" },
    ]);
  });

  it("reportMetrics emite result con ok=true, texto acumulado y métricas", () => {
    const { front, events } = makeFront("json");
    front.turnStarted();
    front.handleEvent({ type: "text_stream", text: "resp" });
    front.handleEvent({ type: "text_stream_end" });
    front.reportMetrics(METRICS);
    const result = events().find((e) => e.type === "result");
    expect(result.ok).toBe(true);
    expect(result.text).toBe("resp");
    expect(result.metrics).toMatchObject({ inputTokens: 500, outputTokens: 200, toolCalls: 2 });
  });

  it("un error (notify) marca result.ok=false y emite un evento error", () => {
    const { front, events } = makeFront("json");
    front.turnStarted();
    front.notify("Error: se cayó todo");
    front.reportMetrics(METRICS);
    expect(events().some((e) => e.type === "error")).toBe(true);
    expect(events().find((e) => e.type === "result").ok).toBe(false);
  });

  it("turnStarted resetea el error del turno anterior", () => {
    const { front, events } = makeFront("json");
    front.turnStarted();
    front.notify("Error: uno");
    front.turnStarted(); // nuevo turno
    front.reportMetrics(METRICS);
    expect(events().find((e) => e.type === "result").ok).toBe(true);
  });

  it("askUser emite ask_user y devuelve una negativa (no cuelga)", async () => {
    const { front, events } = makeFront("json");
    const answer = await front.askUser("¿seguís?");
    expect(events()[0]).toMatchObject({ type: "ask_user", question: "¿seguís?" });
    expect(answer).toMatch(/headless/i);
  });
});

describe("HeadlessFrontend — text", () => {
  it("streamea el texto del asistente a stdout, no a stderr", () => {
    const { front, out, err } = makeFront("text");
    front.turnStarted();
    front.handleEvent({ type: "text_stream", text: "Hola" });
    front.handleEvent({ type: "text_stream_end" });
    expect(out.join("")).toContain("Hola");
    expect(err.join("")).toBe("");
  });

  it("la actividad de tools va a stderr (stdout queda limpio)", () => {
    const { front, out, err } = makeFront("text");
    front.turnStarted();
    front.handleEvent({ type: "tool_use", name: "bash", input: { command: "ls" } });
    expect(err.join("")).toContain("bash");
    expect(out.join("")).toBe("");
  });

  it("no emite JSON en modo texto", () => {
    const { front, out } = makeFront("text");
    front.start();
    front.turnStarted();
    front.handleEvent({ type: "text_stream", text: "x" });
    front.handleEvent({ type: "text_stream_end" });
    expect(() => JSON.parse(out.join(""))).toThrow();
  });
});
