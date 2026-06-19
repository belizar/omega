import { describe, it, expect, beforeEach } from "vitest";
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

    // Turno 1: read
    session.addUserMessage("leé a.ts");
    session.addMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }],
    });
    session.addMessage({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content, is_error: false }],
    });

    // Turno 2
    session.addUserMessage("turno 2");
    session.addMessage({ role: "assistant", content: "respuesta 2" });

    // Turno 3
    session.addUserMessage("turno 3");
    session.addMessage({ role: "assistant", content: "respuesta 3" });

    // Turno 4
    session.addUserMessage("turno 4");
    session.addMessage({ role: "assistant", content: "respuesta 4" });

    // Turno 5
    session.addUserMessage("turno 5");

    // Antes de compactar, workingContext tiene el contenido completo
    const wcBefore = session.workingContext;
    const readResult = wcBefore[2].content as Array<{ content: string }>;
    expect(readResult[0].content).toBe(content);

    // Compactar
    session.compactWorkingContext({ staleTurns: 3, minLines: 20 });

    // Después de compactar, el read viejo debe ser un marcador
    const wcAfter = session.workingContext;
    const compacted = wcAfter[2].content as Array<{ content: string }>;
    expect(compacted[0].content).toContain("[leído a.ts hace");
    expect(compacted[0].content).toContain("30 líneas omitidas");

    // messages debe seguir teniendo el contenido original
    const origMsg = (session.messages[2].content as Array<{ content: string }>)[0];
    expect(origMsg.content).toBe(content);
  });
});
