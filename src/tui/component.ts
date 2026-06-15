import { Key } from "./decodeKey.js";

interface InputComponent<T> {
  render(): string;
  handleKey(key: Key): void;
  isDone(): boolean;
  getResult(): T;
}

export { InputComponent };
