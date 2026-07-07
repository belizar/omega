import { Context } from "../../app-context.js";
import { CommandListItem } from "../../commands/index.js";
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
  commands: CommandListItem[];
};

/**
 * Componente raíz del input. Hostea el LineEditor y, para comandos modales
 * (ej: /resume) y el file picker (@), un SelectList — todo en UNA región viva.
 *
 * Modos:
 *   editing         → solo el LineEditor.
 *   picking         → LineEditor + picker de comando modal debajo.
 *   file-picking    → LineEditor + picker de archivos debajo, en vivo.
 *   command-picking → LineEditor + menú de slash-commands debajo, en vivo.
 */
class Prompt implements InputComponent<PromptResult> {
  #editor: LineEditor;
  #ctx: Context;
  #modals: Record<string, ModalCommand>;
  #commands: CommandListItem[];
  #mode: "editing" | "picking" | "file-picking" | "command-picking";
  #picker: ModalPicker | null;
  #activeModal: ModalCommand | null;
  #filePicker: SelectList<string> | null;
  #fileMentionStart: number;
  #commandPicker: SelectList<CommandListItem> | null;
  #result: PromptResult | null;
  #done: boolean;

  constructor({ editor, ctx, modals, commands }: PromptProps) {
    this.#editor = editor;
    this.#ctx = ctx;
    this.#modals = modals;
    this.#commands = commands;
    this.#mode = "editing";
    this.#picker = null;
    this.#activeModal = null;
    this.#filePicker = null;
    this.#fileMentionStart = -1;
    this.#commandPicker = null;
    this.#result = null;
    this.#done = false;
  }

  handleKey(key: Key): void {
    if (this.#mode === "file-picking") {
      this.#handleFilePicking(key);
    } else if (this.#mode === "command-picking") {
      this.#handleCommandPicking(key);
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
      this.#commit();
      return;
    }

    // Después de cada keystroke, chequear pickers en vivo: primero el menú de
    // slash-commands (buffer entero = /comando), si no, la mención @ de archivos.
    this.#syncCommandPicker();
    if (this.#mode === "command-picking") return;
    this.#syncFilePicker();
  }

  /** Resuelve el buffer comiteado: modal (abre picker), o submit. Compartido
   * entre el Enter del editor y el Enter del menú de comandos. */
  #commit(): void {
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
  }

  // ── command-picking (menú de slash-commands) ─────────────────────

  /** Abre/actualiza/cierra el menú de comandos según el prefijo `/` tipeado. */
  #syncCommandPicker(): void {
    const slash = this.#editor.getSlashCommand();
    if (!slash) {
      this.#commandPicker = null;
      if (this.#mode === "command-picking") this.#mode = "editing";
      return;
    }

    const matches = this.#commands.filter((c) =>
      c.name.slice(1).startsWith(slash.text),
    );
    if (matches.length === 0) {
      this.#commandPicker = null;
      if (this.#mode === "command-picking") this.#mode = "editing";
      return;
    }

    this.#commandPicker = new SelectList(
      matches,
      (c, _i, sel) =>
        sel
          ? bold(cyan("  " + c.name)) + dim("  " + c.description)
          : dim("  " + c.name + "  " + c.description),
      10,
    );
    this.#mode = "command-picking";
  }

  #handleCommandPicking(key: Key): void {
    const picker = this.#commandPicker;
    if (!picker) { this.#mode = "editing"; return; }

    switch (key.type) {
      // Navegación del menú.
      case "up":
      case "down":
        picker.handleKey(key);
        return;

      case "ctrl":
        // Ctrl+N/P navegan; cualquier otro Ctrl va al editor.
        if (key.key === "n" || key.key === "p") { picker.handleKey(key); return; }
        this.#editor.handleKey(key);
        this.#syncCommandPicker();
        return;

      // Tab: completar el comando resaltado en el buffer y seguir editando
      // (para tipear argumentos). No submitea.
      case "tab": {
        const sel = picker.getResult();
        if (sel) this.#editor.setBuffer(sel.name + " ");
        this.#commandPicker = null;
        this.#mode = "editing";
        return;
      }

      // Enter: elegir el comando resaltado y correrlo (o abrir su modal).
      case "enter": {
        const sel = picker.getResult();
        this.#commandPicker = null;
        this.#mode = "editing";
        if (sel) {
          this.#editor.setBuffer(sel.name);
          this.#editor.handleKey({ type: "enter" } as Key);
          if (this.#editor.isDone()) this.#commit();
        }
        return;
      }

      case "escape":
        this.#commandPicker = null;
        this.#mode = "editing";
        return;

      // El resto (char, backspace, movimiento…) edita el buffer y re-sincroniza:
      // filtra la lista, o la cierra si dejó de ser un `/comando`.
      default:
        this.#editor.handleKey(key);
        this.#syncCommandPicker();
        return;
    }
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
    if (this.#mode === "command-picking" && this.#commandPicker) {
      return editor + "\n" + this.#commandPicker.render();
    }
    return editor;
  }

  setBuffer(text: string): void {
    this.#editor.setBuffer(text);
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
    if (this.#mode === "command-picking" && this.#commandPicker) {
      const editorLines = this.#editor.render().split("\n").length;
      return { row: editorLines + this.#commandPicker.selectedRow(), col: 0 };
    }
    return this.#editor.getCursorPosition();
  }
}

export { Prompt, PromptResult };
