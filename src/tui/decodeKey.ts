type Key =
  | { type: "char"; value: string }
  | { type: "enter" }
  | { type: "newline" } // Shift+Enter → insertar salto de línea
  | { type: "backspace" }
  | { type: "delete" } // Supr (forward delete)
  | { type: "tab" }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "home" }
  | { type: "end" }
  | { type: "ctrl"; key: string } // Ctrl-<letra>, ej. {type:"ctrl", key:"c"}
  | { type: "paste"; text: string }
  | { type: "unknown"; raw: string };

function decodeKey(raw: string): Key {
  // 1. Bracketed paste: \x1b[200~ <contenido> \x1b[201~
  if (raw.startsWith("\x1b[200~")) {
    const text = raw.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
    return { type: "paste", text };
  }

  // 2. Escape sequences conocidas (multi-byte)
  switch (raw) {
    case "\x1b[A":
      return { type: "up" };
    case "\x1b[B":
      return { type: "down" };
    case "\x1b[C":
      return { type: "right" };
    case "\x1b[D":
      return { type: "left" };
    case "\x1b[H":
    case "\x1b[1~":
    case "\x1bOH":
      return { type: "home" };
    case "\x1b[F":
    case "\x1b[4~":
    case "\x1bOF":
      return { type: "end" };
    case "\x1b[3~":
      return { type: "delete" };
    case "\x1b[27;2;13~":
      return { type: "newline" }; // Shift+Enter (tu terminal)
  }

  // 3. Teclas de control de un byte (el orden importa: estas ganan sobre el Ctrl genérico)
  if (raw === "\r" || raw === "\n") return { type: "enter" };
  if (raw === "\x7f" || raw === "\b") return { type: "backspace" };
  if (raw === "\t") return { type: "tab" };
  if (raw === "\x1b") return { type: "escape" };

  // Ctrl-<letra>: bytes 0x01..0x1a → 'a'..'z'  (ej. Ctrl-C = 0x03 → "c")
  if (raw.length === 1) {
    const code = raw.charCodeAt(0);
    if (code >= 1 && code <= 26) {
      return { type: "ctrl", key: String.fromCharCode(code + 96) };
    }
  }

  // 4. Un carácter imprimible
  if (raw.length === 1 && raw >= " ") {
    return { type: "char", value: raw };
  }

  // 5. Varios imprimibles juntos = paste sin bracketed mode (permitimos newlines)
  if (raw.length > 1 && ![...raw].some((c) => c < " " && c !== "\n")) {
    return { type: "paste", text: raw };
  }

  // 6. No lo reconocemos
  return { type: "unknown", raw };
}

export { Key, decodeKey };
