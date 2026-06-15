import { Key } from "./decodeKey.js";

interface CursorPosition {
  row: number; // 0-based dentro del render del componente
  col: number;
}

interface InputComponent<T> {
  render(): string;
  handleKey(key: Key): void;
  isDone(): boolean;
  getResult(): T;
  getCursorPosition?(): CursorPosition;
}

export { CursorPosition, InputComponent };
