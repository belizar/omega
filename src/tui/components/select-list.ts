import { InputComponent } from "../component.js";
import { Key } from "../decodeKey.js";

/**
 * Componente de lista seleccionable interactiva.
 *
 * Navegacion: up/down, Ctrl+N/P, j/k (vim)
 * Seleccionar: Enter
 * Cancelar: Escape
 *
 * Si hay mas items que maxVisible, solo se muestra una ventana
 * que se desliza para mantener el item seleccionado a la vista.
 * Esto evita que el terminal scrollee y rompa \x1b7/\x1b8.
 */
class SelectList<T> implements InputComponent<T | null> {
  #items: T[];
  #selectedIndex: number;
  #done: boolean;
  #renderItem: (item: T, index: number, isSelected: boolean) => string;
  #maxVisible: number;

  constructor(
    items: T[],
    renderItem: (item: T, index: number, isSelected: boolean) => string,
    maxVisible = 20,
  ) {
    this.#items = items;
    this.#selectedIndex = 0;
    this.#done = false;
    this.#renderItem = renderItem;
    this.#maxVisible = maxVisible;
  }

  isEmpty(): boolean {
    return this.#items.length === 0;
  }

  /** Reemplaza los items en vivo (para refrescar estados sin perder la selección).
   *  Clampa el índice si la lista se achicó. */
  setItems(items: T[]): void {
    this.#items = items;
    if (this.#selectedIndex >= items.length) {
      this.#selectedIndex = Math.max(0, items.length - 1);
    }
  }

  /** Inicio de la ventana visible (la que sigue al seleccionado). */
  #windowStart(): number {
    const total = this.#items.length;
    const limit = Math.min(total, this.#maxVisible);
    let start = this.#selectedIndex - Math.floor(limit / 2);
    if (start < 0) start = 0;
    if (start + limit > total) start = total - limit;
    return start;
  }

  /** Fila (0-based) del seleccionado dentro de este render. La usa el Prompt
   * para poner el cursor del terminal sobre la opción elegida. */
  selectedRow(): number {
    return this.#selectedIndex - this.#windowStart();
  }

  render(): string {
    if (this.#items.length === 0) return "(vacio)";

    const total = this.#items.length;
    const limit = Math.min(total, this.#maxVisible);
    const start = this.#windowStart();

    const visible = this.#items.slice(start, start + limit);
    const lines = visible.map((item, i) => {
      const realIndex = start + i;
      return this.#renderItem(item, realIndex, realIndex === this.#selectedIndex);
    });

    return lines.join("\n");
  }

  handleKey(key: Key): void {
    switch (key.type) {
      case "up":
        if (this.#selectedIndex > 0) this.#selectedIndex--;
        break;
      case "down":
        if (this.#selectedIndex < this.#items.length - 1) this.#selectedIndex++;
        break;
      case "enter":
        this.#done = true;
        break;
      case "escape":
        this.#selectedIndex = -1;
        this.#done = true;
        break;
      case "ctrl":
        if (key.key === "n" && this.#selectedIndex < this.#items.length - 1) {
          this.#selectedIndex++;
        }
        if (key.key === "p" && this.#selectedIndex > 0) {
          this.#selectedIndex--;
        }
        break;
      case "char":
        if (key.value === "j" && this.#selectedIndex < this.#items.length - 1) {
          this.#selectedIndex++;
        }
        if (key.value === "k" && this.#selectedIndex > 0) {
          this.#selectedIndex--;
        }
        break;
    }
  }

  isDone(): boolean {
    return this.#done;
  }

  getResult(): T | null {
    return this.#selectedIndex >= 0 ? this.#items[this.#selectedIndex] : null;
  }
}

export { SelectList };