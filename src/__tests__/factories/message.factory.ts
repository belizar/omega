import { faker } from "@faker-js/faker";
import { Message, ToolMessage, TextMessage } from "../../message.js";

export class MessageFactory {
  static createUserMessage(content?: string): Message {
    return {
      role: "user",
      content: content || faker.lorem.sentence(),
    };
  }

  static createAssistantMessage(content?: string | any[]): Message {
    return {
      role: "assistant",
      content:
        content ||
        [
          {
            type: "text" as const,
            text: faker.lorem.paragraph(),
          },
        ],
    };
  }

  static createToolResultMessage(toolUseId?: string, content?: string): Message {
    const toolMessage: ToolMessage = {
      type: "tool_result",
      tool_use_id: toolUseId || faker.string.uuid(),
      content: content || faker.lorem.sentence(),
      is_error: false,
    };

    return {
      role: "user",
      content: toolMessage,
    };
  }

  static createTextBlock(text?: string): TextMessage {
    return {
      type: "text",
      text: text || faker.lorem.paragraph(),
    };
  }

  static createToolUseBlock(name?: string, input?: object) {
    return {
      type: "tool_use",
      id: faker.string.uuid(),
      name: name || faker.word.verb(),
      input: input || { param: faker.lorem.word() },
    };
  }

  static createMultipleMessages(count: number): Message[] {
    const messages: Message[] = [];
    for (let i = 0; i < count; i++) {
      if (i % 2 === 0) {
        messages.push(this.createUserMessage());
      } else {
        messages.push(this.createAssistantMessage());
      }
    }
    return messages;
  }
}
