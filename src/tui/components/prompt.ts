import { Context } from "../../app-context.js";
import { ModalCommand, ModalPicker } from "../../commands/modal-command.js";
import { CursorPosition, InputComponent } from "../component.js";
import { Key } from "../decodeKey.js";
import { LineEditor } from "./line-editor.js";
import { SelectList } from "./select-list.js";
import { bold, dim, cyan } from "../theme.js";

type PromptResult =
  | { kind: "submit"; text: string }
  | { kind: "modal"; message?: string };

type PromptProps = {
  editor: LineEditor;
  ctx: Context;
  modals: Record<string, ModalCommand>;
};

/**
 * Componente raíz del input. Hostea el LineEditor y, para comandos modales
 * (ej: /resume) y el file picker (@), un SelectList — todo en UNA región viva.
 *
 * Modos:
 *   editing      → solo el LineEditor.
 *   picking      → LineEditor + picker de comando modal debajo.
 *   file-picking → LineEditor + picker de archivos debajo, se actualiza en vivo.
 */
class Prompt implements InputComponent<PromptResult> {
  #editor: LineEditor;
  #ctx: Context;
  #modals: Record<string, ModalCommand>;
  #mode: "editing" | "picking" | "file-picking";
  #picker: ModalPicker | null;
  #activeModal: ModalCommand | null;
  #filePicker: SelectList<string> | null;
  #fileMentionStart: number;
  #result: PromptResult | null;
  #done: boolean;

  constructor({ editor, ctx, modals }: PromptProps) {
    this.#editor = editor;
    this.#ctx = ctx;
    this.#modals = modals;
    this.#mode = "editing";
    this.#picker = null;
    this.#activeModal = null;
    this.#filePicker = null;
    this.#fileMentionStart = -1;
    this.#result = null;
    this.#done = false;
  }

  handleKey(key: Key): void {
    if (this.#mode === "file-picking") {
      this.#handleFilePicking(key);
    } else if (this.#mode === "picking") {
      this.#handlePicking(key);
    } else {
      this.#handleEditing(key);
    }
  }

  // ── editing ──────────────────────────────────────────────────────

  #handleEditing(key: Key): void {
    // Si el editor ya está done (después de un reopen), solo dejamos
    // que siga normalmente.
    this.#editor.handleKey(key);

    // Si el editor comiteó (Enter), procesar comando modal o submit
    if (this.#editor.isDone()) {
      const text = this.#editor.getResult();
      const tokens = text.trim().split(/\s+/);
      const modal = tokens.length === 1 ? this.#modals[tokens[0]] : undefined;

      if (!modal) {
        this.#result = { kind: "submit", text };
        this.#done = true;
        return;
      }

      const opened = modal.open(this.#ctx);
      if ("message" in opened) {
        this.#result = { kind: "modal", message: opened.message };
        this.#done = true;
        return;
      }

      this.#picker = opened.picker;
      this.#activeModal = modal;
      this.#mode = "picking";
      return;
    }

    // Después de cada keystroke, chequear si hay una mención @ activa
    // para abrir/actualizar el file picker.
    this.#syncFilePicker();
  }

  /** Abre, actualiza o cierra el file picker según el estado de la mención @. */
  #syncFilePicker(): void {
    const mention = this.#editor.getAtMention();

    if (!mention) {
      this.#filePicker = null;
      return;
    }

    const files = LineEditor.listFiles(mention.text);
    if (files.length === 0) {
      this.#filePicker = null;
      return;
    }

    this.#fileMentionStart = mention.start;
    this.#filePicker = new SelectList(
      files,
      (f, _i, sel) => sel ? bold(cyan("  " + f)) : dim("  " + f),
      15,
    );
    this.#mode = "file-picking";
  }

  // ── file-picking ─────────────────────────────────────────────────

  #handleFilePicking(key: Key): void {
    const picker = this.#filePicker;
    if (!picker) { this.#mode = "editing"; return; }

    switch (key.type) {
      // Teclas que van al editor (modifican texto o mueven cursor)
      case "char":
      case "paste":
      case "newline":
      case "backspace":
      case "delete":
      case "left":
      case "right":
      case "home":
      case "end":
      case "ctrl":
        this.#editor.handleKey(key);
        this.#syncFilePicker();
        if (!this.#filePicker) this.#mode = "editing";
        return;

      case "tab": {
        // Completar prefijo común
        const mention = this.#editor.getAtMention();
        if (!mention) { this.#mode = "editing"; return; }
        const files = LineEditor.listFiles(mention.text);
        if (files.length === 0) return;
        let common = files[0].replace(/\/$/, "");
        for (const f of files) {
          const n = f.replace(/\/$/, "");
          for (let i = 0; i < common.length; i++) {
            if (i >= n.length || n[i] !== common[i]) {
              common = common.slice(0, i);
              break;
            }
          }
        }
        if (common.length > mention.text.length) {
          const suffix = common.slice(mention.text.length);
          this.#editor.replaceRange(
            mention.start + 1 + mention.text.length,
            mention.start + 1 + mention.text.length,
            suffix,
          );
        }
        this.#syncFilePicker();
        return;
      }

      // Navegación del picker
      case "up":
      case "down":
        picker.handleKey(key);
        return;

      case "enter": {
        // Insertar el archivo seleccionado
        const selected = picker.getResult();
        this.#filePicker = null;
        if (selected !== null) {
          // Reemplazar el @parcial por @ruta
          const mention = this.#editor.getAtMention();
          if (mention) {
            this.#editor.replaceRange(mention.start, mention.start + 1 + mention.text.length, "@" + selected);
          }
          // Si es directorio, seguir en file-picking
          if (selected.endsWith("/")) {
            this.#syncFilePicker();
            if (this.#filePicker) { this.#mode = "file-picking"; return; }
          }
        }
        this.#mode = "editing";
        return;
      }

      case "escape":
        // Cancelar: borrar la mención @
        this.#filePicker = null;
        this.#mode = "editing";
        {
          const mention = this.#editor.getAtMention();
          if (mention) {
            this.#editor.replaceRange(mention.start, mention.start + 1 + mention.text.length, "");
          }
        }
        return;
    }
  }

  // ── picking (comando modal) ──────────────────────────────────────

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
      this.#mode = "editing";
      this.#editor.reopen();
      return;
    }

    const message = modal.apply(this.#ctx, value) || undefined;
    this.#result = { kind: "modal", message };
    this.#mode = "editing";
    this.#done = true;
  }

  // ── InputComponent ───────────────────────────────────────────────

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
    if (this.#mode === "file-picking" && this.#filePicker) {
      return editor + "\n" + this.#filePicker.render();
    }
    return editor;
  }

  getCursorPosition(): CursorPosition {
    if (this.#mode === "picking" && this.#picker) {
      const editorLines = this.#editor.render().split("\n").length;
      return { row: editorLines + this.#picker.selectedRow(), col: 0 };
    }
    if (this.#mode === "file-picking" && this.#filePicker) {
      const editorLines = this.#editor.render().split("\n").length;
      return { row: editorLines + this.#filePicker.selectedRow(), col: 0 };
    }
    return this.#editor.getCursorPosition();
  }
}

export { Prompt, PromptResult };
