import { describe, it, expect } from "vitest";
import { WebFrontend, historyFromMessages } from "../../frontend/web-frontend.js";
import type { RunnerEvent } from "../../runner.js";
import type { Message } from "../../message.js";

function make() {
  return new WebFrontend({ model: "test-model", sessionId: "sess-1" });
}
/** Registra un cliente que acumula los eventos parseados que recibe. */
function client(f: WebFrontend) {
  const got: any[] = [];
  const unsub = f.addClient((data) => got.push(JSON.parse(data)));
  return { got, unsub };
}

describe("WebFrontend — hub", () => {
  it("le manda `ready` al cliente al conectarse", () => {
    const f = make();
    const c = client(f);
    expect(c.got[0]).toEqual({ type: "ready", session: "sess-1", model: "test-model" });
  });

  it("fan-out: broadcastea cada evento a TODOS los clientes", () => {
    const f = make();
    const a = client(f), b = client(f);
    f.handleEvent({ type: "tool_use", name: "read", input: { path: "x.ts" } } as RunnerEvent);
    const evA = a.got.find((e) => e.type === "tool_use");
    const evB = b.got.find((e) => e.type === "tool_use");
    expect(evA).toEqual({ type: "tool_use", name: "read", input: { path: "x.ts" } });
    expect(evB).toEqual(evA); // los dos clientes ven lo mismo
    expect(f.clientCount).toBe(2);
  });

  it("un cliente dado de baja deja de recibir", () => {
    const f = make();
    const a = client(f);
    a.unsub();
    f.handleEvent({ type: "text", text: "hola" } as RunnerEvent);
    expect(a.got.some((e) => e.type === "assistant")).toBe(false);
    expect(f.clientCount).toBe(0);
  });

  it("fan-in: submitInput de cualquier cliente resuelve nextInput", async () => {
    const f = make();
    const p = f.nextInput();
    f.submitInput("hacé la tarea");
    expect(await p).toEqual({ kind: "message", text: "hacé la tarea", pastedImages: [] });
  });

  it("nextInput espera si no hay input todavía (orden push→resolve)", async () => {
    const f = make();
    f.submitInput("temprano");
    expect((await f.nextInput()) as any).toMatchObject({ text: "temprano" });
  });

  it("`exit` / `/exit` piden salir", async () => {
    const f = make();
    f.submitInput("/exit");
    expect(await f.nextInput()).toEqual({ kind: "exit" });
  });

  it("askUser broadcastea la pregunta y la próxima respuesta la resuelve", async () => {
    const f = make();
    const c = client(f);
    const ans = f.askUser("¿seguir?");
    expect(c.got.some((e) => e.type === "ask_user" && e.question === "¿seguir?")).toBe(true);
    f.submitInput("sí, dale");
    expect(await ans).toBe("sí, dale");
  });

  it("mapea eventos del runner al contrato web (streaming)", () => {
    const f = make();
    const c = client(f);
    f.turnStarted();
    f.handleEvent({ type: "text_stream", text: "ho" } as RunnerEvent);
    f.handleEvent({ type: "text_stream", text: "la" } as RunnerEvent);
    f.handleEvent({ type: "text_stream_end" } as RunnerEvent);
    f.turnEnded();
    // Los eventos de `status` son ortogonales al mapeo runner→web; los ignoramos acá.
    const types = c.got.map((e) => e.type).filter((t) => t !== "status");
    expect(types).toEqual(["ready", "turn_start", "delta", "delta", "assistant_end", "turn_end"]);
    expect(c.got.filter((e) => e.type === "delta").map((e) => e.text)).toEqual(["ho", "la"]);
  });

  it("estado: idle → running (turnStarted) → idle (turnEnded)", () => {
    const f = make();
    const c = client(f);
    expect(f.status).toBe("idle");
    f.turnStarted();
    expect(f.status).toBe("running");
    f.turnEnded();
    expect(f.status).toBe("idle");
    const statuses = c.got.filter((e) => e.type === "status").map((e) => e.status);
    expect(statuses).toEqual(["running", "idle"]);
  });

  it("estado: waiting mientras askUser espera, running tras la respuesta", async () => {
    const f = make();
    f.turnStarted();
    const ans = f.askUser("¿seguir?");
    expect(f.status).toBe("waiting");
    f.submitInput("dale");
    await ans;
    expect(f.status).toBe("running");
  });

  it("historyFromMessages aplana texto, tool_use y tool_result en orden", () => {
    const msgs: Message[] = [
      { role: "user", content: "hola" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "voy a leer" },
          { type: "tool_use", id: "1", name: "read", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "cuerpo", is_error: false }] },
      { role: "assistant", content: "listo" },
    ];
    const items = historyFromMessages(msgs);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool_use", "tool_result", "assistant"]);
    expect(items[0]).toMatchObject({ text: "hola" });
    expect(items[2]).toMatchObject({ name: "read", input: { path: "a.ts" } });
    expect(items[3]).toMatchObject({ output: "cuerpo", isError: false });
  });

  it("addClient re-emite el historial (fix: cambiar de sesión no borra la conversación)", () => {
    const msgs: Message[] = [
      { role: "user", content: "acordate" },
      { role: "assistant", content: "listo" },
    ];
    const f = new WebFrontend({ model: "m", sessionId: "s", getMessages: () => msgs });
    const got: any[] = [];
    f.addClient((d) => got.push(JSON.parse(d)));
    const hist = got.find((e) => e.type === "history");
    expect(hist).toBeTruthy();
    expect(hist.items.map((i: any) => i.kind)).toEqual(["user", "assistant"]);
    // ready antes que history
    expect(got[0].type).toBe("ready");
  });

  it("sin historial (sesión nueva) no emite history", () => {
    const f = new WebFrontend({ model: "m", sessionId: "s", getMessages: () => [] });
    const got: any[] = [];
    f.addClient((d) => got.push(JSON.parse(d)));
    expect(got.find((e) => e.type === "history")).toBeUndefined();
  });
});
