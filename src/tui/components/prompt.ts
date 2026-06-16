import { Context } from "../../app-context.js";
import { ModalCommand, ModalPicker } from "../../commands/modal-command.js";
import { CursorPosition, InputComponent } from "../component.js";
import { Key } from "../decodeKey.js";
import { LineEditor } from "./line-editor.js";

type PromptResult =
  | { kind: "submit"; text: string } // input normal o comando no-modal: lo resuelve el loop
  | { kind: "modal"; message?: string }; // un comando modal ya hizo su efecto

type PromptProps = {
  editor: LineEditor;
  ctx: Context;
  modals: Record<string, ModalCommand>;
};

/**
 * Componente raíz del input. Hostea el LineEditor y, para comandos modales
 * (ej: /resume), un SelectList — todo en UNA región viva.
 *
 *   editing  → solo el LineEditor.
 *   picking  → LineEditor + picker debajo.
 *
 * Como el render vuelve a estado y el driver limpia de la región hacia abajo,
 * cancelar el modal (Esc) colapsa la lista solo: el render pasa a ser más corto.
 * Nada se commitea hasta un final de "aceptar"; Esc vuelve a editing con el
 * buffer intacto (por eso el editor expone reopen()).
 */
class Prompt implements InputComponent<PromptResult> {
  #editor: LineEditor;
  #ctx: Context;
  #modals: Record<string, ModalCommand>;
  #mode: "editing" | "picking";
  #picker: ModalPicker | null;
  #activeModal: ModalCommand | null;
  #result: PromptResult | null;
  #done: boolean;

  constructor({ editor, ctx, modals }: PromptProps) {
    this.#editor = editor;
    this.#ctx = ctx;
    this.#modals = modals;
    this.#mode = "editing";
    this.#picker = null;
    this.#activeModal = null;
    this.#result = null;
    this.#done = false;
  }

  handleKey(key: Key): void {
    if (this.#mode === "editing") {
      this.#handleEditing(key);
    } else {
      this.#handlePicking(key);
    }
  }

  #handleEditing(key: Key): void {
    this.#editor.handleKey(key);
    if (!this.#editor.isDone()) return;

    const text = this.#editor.getResult();
    const tokens = text.trim().split(/\s+/);
    // Solo el comando "pelado" (sin args) abre modal; "/resume 3" cae al loop.
    const modal = tokens.length === 1 ? this.#modals[tokens[0]] : undefined;

    if (!modal) {
      this.#result = { kind: "submit", text };
      this.#done = true;
      return;
    }

    const opened = modal.open(this.#ctx);
    if ("message" in opened) {
      // no hay nada que elegir (ej: no hay sesiones guardadas)
      this.#result = { kind: "modal", message: opened.message };
      this.#done = true;
      return;
    }

    // entramos al picker; el editor queda "submitted" pero lo reabrimos si cancela
    this.#picker = opened.picker;
    this.#activeModal = modal;
    this.#mode = "picking";
  }

  #handlePicking(key: Key): void {
    const picker = this.#picker;
    const modal = this.#activeModal;
    if (!picker || !modal) return;

    picker.handleKey(key);
    if (!picker.isDone()) return;

    const value = picker.getResult(); // null = cancelado (Esc)
    this.#picker = null;
    this.#activeModal = null;

    if (value === null) {
      // volver a editar la MISMA línea, con "/resume" intacto
      this.#mode = "editing";
      this.#editor.reopen();
      return;
    }

    const message = modal.apply(this.#ctx, value) || undefined;
    this.#result = { kind: "modal", message };
    this.#mode = "editing"; // que el render final sea solo el editor (la lista se va)
    this.#done = true;
  }

  isDone(): boolean {
    return this.#done;
  }

  getResult(): PromptResult {
    return this.#result ?? { kind: "submit", text: this.#editor.getResult() };
  }

  render(): string {
    const editor = this.#editor.render();
    if (this.#mode === "picking" && this.#picker) {
      return editor + "\n" + this.#picker.render();
    }
    return editor;
  }

  getCursorPosition(): CursorPosition {
    if (this.#mode === "picking" && this.#picker) {
      const editorLines = this.#editor.render().split("\n").length;
      return { row: editorLines + this.#picker.selectedRow(), col: 0 };
    }
    return this.#editor.getCursorPosition();
  }
}

export { Prompt, PromptResult };
