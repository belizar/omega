import { describe, it, expect, beforeEach } from "vitest";
import { Session } from "../session.js";
import { MessageFactory } from "./factories/message.factory.js";

describe("Session", () => {
  let session: Session;

  beforeEach(() => {
    session = new Session();
  });

  it("should initialize with empty messages", () => {
    expect(session.messages).toHaveLength(0);
  });

  it("should add user messages", () => {
    session.addUserMessage("Hello");
    expect(session.messages).toHaveLength(1);
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
});
