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

  render(): string {
    if (this.#items.length === 0) return "(vacio)";

    const total = this.#items.length;
    const limit = Math.min(total, this.#maxVisible);

    // Calcular ventana: mantener el seleccionado visible
    let start = this.#selectedIndex - Math.floor(limit / 2);
    if (start < 0) start = 0;
    if (start + limit > total) start = total - limit;

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