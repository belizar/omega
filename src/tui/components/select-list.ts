import { InputComponent } from "../component.js";
import { Key } from "../decodeKey.js";

/**
 * Componente de lista seleccionable interactiva.
 * Implementa InputComponent para integrarse con run().
 *
 * Navegación: up/down, Ctrl+N/P, j/k (vim)
 * Seleccionar: Enter
 * Cancelar: Escape
 */
class SelectList<T> implements InputComponent<T | null> {
  #items: T[];
  #selectedIndex: number;
  #done: boolean;
  #renderItem: (item: T, index: number, isSelected: boolean) => string;

  /**
   * @param items       Elementos a mostrar.
   * @param renderItem  Función que renderiza un ítem. Recibe el ítem, su índice
   *                    y si está seleccionado. Debe devolver una string (sin \n).
   */
  constructor(
    items: T[],
    renderItem: (item: T, index: number, isSelected: boolean) => string,
  ) {
    this.#items = items;
    this.#selectedIndex = 0;
    this.#done = false;
    this.#renderItem = renderItem;
  }

  render(): string {
    if (this.#items.length === 0) return "(vacío)";
    return this.#items
      .map((item, i) => this.#renderItem(item, i, i === this.#selectedIndex))
      .join("\n");
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
        this.#selectedIndex = -1; // señal de cancelación
        this.#done = true;
        break;
      case "ctrl":
        if (key.key === "n") {
          if (this.#selectedIndex < this.#items.length - 1) this.#selectedIndex++;
        }
        if (key.key === "p") {
          if (this.#selectedIndex > 0) this.#selectedIndex--;
        }
        break;
      case "char":
        // vim-style j/k
        if (key.value === "j") {
          if (this.#selectedIndex < this.#items.length - 1) this.#selectedIndex++;
        }
        if (key.value === "k") {
          if (this.#selectedIndex > 0) this.#selectedIndex--;
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