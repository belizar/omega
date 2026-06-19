import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Session } from "../session.js";
import { MessageFactory } from "./factories/message.factory.js";
import { Message } from "../message.js";

describe("Session", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session();
  });

  it("should initialize with empty messages and workingContext", () => {
    expect(session.messages).toHaveLength(0);
    expect(session.workingContext).toHaveLength(0);
    expect(session.getContext()).toHaveLength(0);
  });

  it("should add user messages", () => {
    session.addUserMessage("Hello");
    expect(session.messages).toHaveLength(1);
    expect(session.workingContext).toHaveLength(1);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[0].content).toBe("Hello");
  });

  it("should add multiple user messages", () => {
    session.addUserMessage("First");
    session.addUserMessage("Second");
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].content).toBe("First");
    expect(session.messages[1].content).toBe("Second");
  });

  it("should add assistant messages", () => {
    const assistantMsg = MessageFactory.createAssistantMessage("Response");
    session.addMessage(assistantMsg);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("assistant");
  });

  it("should maintain message order", () => {
    session.addUserMessage("User message");
    const assistantMsg = MessageFactory.createAssistantMessage();
    session.addMessage(assistantMsg);
    session.addUserMessage("Another user message");

    expect(session.messages).toHaveLength(3);
    expect(session.messages[0].role).toBe("user");
    expect(session.messages[1].role).toBe("assistant");
    expect(session.messages[2].role).toBe("user");
  });

  it("should return a copy of messages array", () => {
    session.addUserMessage("Test");
    const messages1 = session.messages;
    const messages2 = session.messages;
    expect(messages1).toEqual(messages2);
  });

  it("clear() should reset both messages and workingContext", () => {
    session.addUserMessage("Hello");
    session.addMessage(MessageFactory.createAssistantMessage());
    expect(session.messages).toHaveLength(2);
    expect(session.workingContext).toHaveLength(2);

    session.clear();
    expect(session.messages).toHaveLength(0);
    expect(session.workingContext).toHaveLength(0);
  });

  it("getContext() should return workingContext pruned by tokens", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `linea ${i}`);
    const content = lines.join("\n");

    session.addUserMessage("leé esto");
    session.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }],
    });
    session.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content, is_error: false }],
    });
    session.addMessage({
      role: "assistant",
      content: "listo",
    });
    session.addUserMessage("gracias");

    const ctx = session.getContext();
    // Debe empezar con user y terminar con user
    expect(ctx.length).toBeGreaterThan(0);
    expect(ctx[0].role).toBe("user");
    expect(ctx[ctx.length - 1].role).toBe("user");
  });

  it("compactWorkingContext() should compact stale reads", () => {
    // Crear un read grande y varios turnos después para que sea stale
    const lines = Array.from({ length: 30 }, (_, i) => `linea ${i}`);
    const content = lines.join("\n");

    // Turno 1: read (paso 1 del agente)
    session.addUserMessage("leé a.ts");
    session.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }],
    });
    session.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content, is_error: false }],
    });

    // Turnos 2-7: 6 pasos más (6 assistants)
    session.addUserMessage("turno 2");
    session.addMessage({ role: "assistant", content: "respuesta 2" });
    session.addUserMessage("turno 3");
    session.addMessage({ role: "assistant", content: "respuesta 3" });
    session.addUserMessage("turno 4");
    session.addMessage({ role: "assistant", content: "respuesta 4" });
    session.addUserMessage("turno 5");
    session.addMessage({ role: "assistant", content: "respuesta 5" });
    session.addUserMessage("turno 6");
    session.addMessage({ role: "assistant", content: "respuesta 6" });
    session.addUserMessage("turno 7");

    // Antes de compactar, workingContext tiene el contenido completo
    const wcBefore = session.workingContext;
    const readResult = wcBefore[2].content as Array<{ content: string }>;
    expect(readResult[0].content).toBe(content);

    // Compactar: age = 7-1 = 6 > 3 → compactado
    session.compactWorkingContext({ staleSteps: 3, minLines: 20 });

    // Después de compactar, el read viejo debe ser un marcador
    const wcAfter = session.workingContext;
    const compacted = wcAfter[2].content as Array<{ content: string }>;
    expect(compacted[0].content).toContain("[leído a.ts hace");
    expect(compacted[0].content).toContain("pasos");
    expect(compacted[0].content).toContain("usá read");

    // messages debe seguir teniendo el contenido original
    const origMsg = (session.messages[2].content as Array<{ content: string }>)[0];
    expect(origMsg.content).toBe(content);
  });

  // ── addUsage ──────────────────────────────────────────────────────────────

  it("addUsage() should accumulate tokens and cost", () => {
    session.addUsage(100, 50, 0.001);
    expect(session.totalTokens).toEqual({ input: 100, output: 50 });
    expect(session.totalCost).toBe(0.001);

    session.addUsage(200, 75, 0.002);
    expect(session.totalTokens).toEqual({ input: 300, output: 125 });
    expect(session.totalCost).toBe(0.003);
  });

  // ── info ──────────────────────────────────────────────────────────────────

  it("info() should return session metadata", () => {
    session.addUserMessage("hello");
    session.addUsage(10, 5, 0.0001);

    const info = session.info();
    expect(info.id).toBe(session.id);
    expect(info.name).toBe("");
    expect(info.messageCount).toBe(1);
    expect(info.persisted).toBe(false);
    expect(info.path).toBeUndefined();
    expect(info.totalCost).toBe(0.0001);
    expect(info.totalTokens).toEqual({ input: 10, output: 5 });
  });

  it("info() should report persisted=true when session has a dir", () => {
    const persisted = new Session({ dir: "/tmp/omega-test-sessions" });
    const info = persisted.info();
    expect(info.persisted).toBe(true);
    expect(info.path).toContain(persisted.id);
  });

  // ── rename ────────────────────────────────────────────────────────────────

  it("rename() should update name (in-memory only)", () => {
    session.rename("Mi sesión");
    expect(session.name).toBe("Mi sesión");
  });

  it("rename() should trim whitespace", () => {
    session.rename("  con espacios  ");
    expect(session.name).toBe("con espacios");
  });

  // ── getters ───────────────────────────────────────────────────────────────

  it("should expose id, name, totalCost, totalTokens", () => {
    expect(session.id).toBeTypeOf("string");
    expect(session.name).toBe("");
    expect(session.totalCost).toBe(0);
    expect(session.totalTokens).toEqual({ input: 0, output: 0 });

    session.addUsage(10, 5, 0.001);
    expect(session.totalCost).toBe(0.001);
    expect(session.totalTokens).toEqual({ input: 10, output: 5 });
  });

  it("should expose maxContextTokens and contextTokens", () => {
    expect(session.maxContextTokens).toBe(100_000);
    expect(session.contextTokens).toBe(0);

    session.addUserMessage("hola mundo");
    expect(session.contextTokens).toBeGreaterThan(0);
  });

  it("should accept custom maxContextTokens", () => {
    const s = new Session({ maxContextTokens: 5000 });
    expect(s.maxContextTokens).toBe(5000);
  });
});

// ── Persistencia en disco ────────────────────────────────────────────────────

describe("Session persistence", () => {
  const testDir = "/tmp/omega-test-sessions";

  beforeEach(() => {
    // Limpiar directorio de tests
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should persist session to disk when dir is provided", () => {
    const s = new Session({ dir: testDir });
    s.addUserMessage("hello");
    s.addUsage(10, 5, 0.001);

    const files = readdirSync(testDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(s.id);
    expect(files[0]).toMatch(/\.json$/);
  });

  it("should persist rename to disk", () => {
    const s = new Session({ dir: testDir });
    s.addUserMessage("hello");
    s.rename("Mi sesión persistida");

    // Reanudar la misma sesión
    const s2 = new Session({ dir: testDir, id: s.id });
    expect(s2.name).toBe("Mi sesión persistida");
    expect(s2.messages).toHaveLength(1);
  });

  it("should resume a session from disk", () => {
    const id = "test-resume-id";

    // Crear y guardar
    const s1 = new Session({ dir: testDir, id });
    s1.addUserMessage("mensaje 1");
    s1.addUsage(100, 50, 0.005);
    s1.rename("Sesión de prueba");

    // Reanudar
    const s2 = new Session({ dir: testDir, id });
    expect(s2.id).toBe(id);
    expect(s2.name).toBe("Sesión de prueba");
    expect(s2.messages).toHaveLength(1);
    expect(s2.messages[0].content).toBe("mensaje 1");
    expect(s2.totalCost).toBe(0.005);
    expect(s2.totalTokens).toEqual({ input: 100, output: 50 });
  });

  it("should persist workingContext alongside messages", () => {
    const id = "test-wc-id";
    const lines = Array.from({ length: 30 }, (_, i) => `linea ${i}`);
    const content = lines.join("\n");

    const s1 = new Session({ dir: testDir, id });
    s1.addUserMessage("leé a.ts");
    s1.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }],
    });
    s1.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content, is_error: false }],
    });

    // Reanudar: workingContext debe estar preservado
    const s2 = new Session({ dir: testDir, id });
    expect(s2.workingContext).toHaveLength(3);
    // El tool_result debe tener el contenido original
    const tr = s2.workingContext[2].content as Array<{ content: string }>;
    expect(tr[0].content).toBe(content);
  });

  it("should persist clear() to disk", () => {
    const id = "test-clear-id";
    const s1 = new Session({ dir: testDir, id });
    s1.addUserMessage("mensaje");
    s1.clear();

    const s2 = new Session({ dir: testDir, id });
    expect(s2.messages).toHaveLength(0);
  });

  it("should not persist when dir is not provided (in-memory only)", () => {
    const s = new Session();
    s.addUserMessage("ephemeral");

    // No debería haber creado archivos
    const files = readdirSync(testDir);
    expect(files).toHaveLength(0);
  });

  it("should handle corrupted session file gracefully", () => {
    const id = "corrupt-id";
    writeFileSync(join(testDir, `${id}.json`), "not valid json {{{");

    const s = new Session({ dir: testDir, id });
    // Debe iniciar fresco sin crashear
    expect(s.messages).toHaveLength(0);
    expect(s.name).toBe("");
    expect(s.totalCost).toBe(0);
  });

  it("should load sessions in old format (without workingContext)", () => {
    const id = "old-format-id";
    // Simular formato viejo: sin workingContext
    writeFileSync(
      join(testDir, `${id}.json`),
      JSON.stringify({
        id,
        name: "old",
        messages: [{ role: "user" as const, content: "hello old" }],
        totalCost: 0.001,
        totalTokens: { input: 10, output: 5 },
      }),
    );

    const s = new Session({ dir: testDir, id });
    expect(s.name).toBe("old");
    expect(s.messages).toHaveLength(1);
    // Debe regenerar workingContext desde messages
    expect(s.workingContext).toHaveLength(1);
  });
});

// ── listSessions ─────────────────────────────────────────────────────────────

describe("Session.listSessions", () => {
  const testDir = "/tmp/omega-test-list";

  beforeEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should return empty array for non-existent directory", () => {
    const result = Session.listSessions("/tmp/omega-nonexistent-xyz");
    expect(result).toEqual([]);
  });

  it("should return empty array for empty directory", () => {
    const result = Session.listSessions(testDir);
    expect(result).toEqual([]);
  });

  it("should list persisted sessions ordered by most recent first", () => {
    // Crear sesiones con timestamps distintos
    const s1 = new Session({ dir: testDir, id: "a" });
    s1.addUserMessage("primera");

    const s2 = new Session({ dir: testDir, id: "b" });
    s2.addUserMessage("segunda");
    s2.rename("Segunda sesión");

    const result = Session.listSessions(testDir);
    expect(result).toHaveLength(2);
    // La más reciente primero
    expect(result[0].id).toBe("b");
    expect(result[0].name).toBe("Segunda sesión");
    expect(result[0].messageCount).toBe(1);
    expect(result[1].id).toBe("a");
  });

  it("should include totalCost and totalTokens in listing", () => {
    const s = new Session({ dir: testDir, id: "cost-test" });
    s.addUsage(100, 50, 0.005);

    const result = Session.listSessions(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].totalCost).toBe(0.005);
    expect(result[0].totalTokens).toEqual({ input: 100, output: 50 });
  });
});
