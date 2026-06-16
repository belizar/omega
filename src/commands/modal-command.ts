import { Context } from "../app-context.js";
import { InputComponent } from "../tui/component.js";

/**
 * Lo que el Prompt necesita de un picker: un InputComponent que puede devolver
 * null (cancelado) y decir en qué fila está la selección (para el cursor).
 * Una interface mínima en vez de SelectList<unknown> esquiva el problema de
 * varianza del campo privado #renderItem.
 */
interface ModalPicker extends InputComponent<unknown> {
  selectedRow(): number;
}

type ModalOpen =
  | { picker: ModalPicker }
  | { message: string };

/**
 * Un comando "modal": en vez de imprimir y terminar, abre un picker que se
 * queda vivo en la MISMA región que el LineEditor. El Prompt lo hostea —
 * Esc rebobina al editor con el texto intacto, Enter aplica la selección.
 *
 * Distinto de Command (fire-and-forget): /clear, /rename, /help imprimen y
 * listo; /resume (y el futuro /model) abren un picker interactivo.
 */
interface ModalCommand {
  name: string;
  /** Abre el modal: un picker para elegir, o un mensaje si no hay nada que elegir. */
  open(ctx: Context): ModalOpen;
  /** Aplica la selección. Devuelve un mensaje de confirmación opcional. */
  apply(ctx: Context, value: unknown): string | void;
}

export { ModalCommand, ModalOpen, ModalPicker };
