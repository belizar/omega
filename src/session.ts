import { Message } from "./message.js";

class Session {
  #messages: Message[];

  constructor() {
    this.#messages = [];
  }

  addUserMessage(msg: string) {
    this.#messages.push({
      role: "user",
      content: msg,
    });
  }

  addMessage(msg: Message) {
    this.#messages.push(msg);
  }

  get messages() {
    return this.#messages;
  }
}

export { Session };
