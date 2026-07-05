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
  /** Precarga el editor con texto (ej: la línea de type-ahead en curso, que el
   * Screen sincroniza para que se dibuje dentro del editor real). */
  setBuffer?(text: string): void;
  /** Contenido pendiente para mostrar ARRIBA del editor (scrollback).
   * El Screen lo drena después de handleKey y lo rutea por printAbove. */
  takeOutput?(): string | null;
}

export { CursorPosition, InputComponent };
