import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, Server } from "http";
import { DaemonClient } from "../../frontend/daemon-client.js";

/** Un daemon de mentira: responde el contrato mínimo para probar el cliente. */
function mockDaemon(): Promise<{ server: Server; port: number; got: any[] }> {
  const got: any[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    got.push({ method: req.method, path: url.pathname, session: url.searchParams.get("session") });

    if (req.method === "GET" && url.pathname === "/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions: [{ id: "s1", title: "una", live: true }], default: "s1" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/input") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        got[got.length - 1].body = JSON.parse(body);
        res.writeHead(204).end();
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": connected\n\n");
      res.write(`data: ${JSON.stringify({ type: "ready", session: "s1", model: "m" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "delta", text: "ho" })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "delta", text: "la" })}\n\n`);
      res.write(": ping\n\n");
      res.write(`data: ${JSON.stringify({ type: "turn_end" })}\n\n`);
      // deja la conexión abierta (SSE)
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, got });
    });
  });
}

describe("DaemonClient", () => {
  let server: Server;
  let port: number;
  let got: any[];
  let client: DaemonClient;

  beforeEach(async () => {
    ({ server, port, got } = await mockDaemon());
    client = new DaemonClient(port);
  });

  afterEach(() => {
    server.close();
  });

  it("ping detecta el daemon arriba", async () => {
    expect(await client.ping()).toBe(true);
  });

  it("ping es false si no hay daemon en ese puerto", async () => {
    expect(await new DaemonClient(1).ping()).toBe(false);
  });

  it("sessions() parsea la lista y el default", async () => {
    const { sessions, default: def } = await client.sessions();
    expect(def).toBe("s1");
    expect(sessions[0].title).toBe("una");
  });

  it("input() postea el texto a la sesión correcta", async () => {
    await client.input("s1", "hacé la tarea");
    const call = got.find((g) => g.path === "/input");
    expect(call.session).toBe("s1");
    expect(call.body).toEqual({ text: "hacé la tarea" });
  });

  it("events() parsea los frames SSE (ignora comentarios)", async () => {
    const evs: any[] = [];
    const unsub = client.events("s1", (e) => evs.push(e));
    // Esperamos a que lleguen los frames
    await new Promise((r) => setTimeout(r, 150));
    unsub();
    const types = evs.map((e) => e.type);
    expect(types).toEqual(["ready", "delta", "delta", "turn_end"]);
    expect(evs.filter((e) => e.type === "delta").map((e) => e.text)).toEqual(["ho", "la"]);
  });
});
