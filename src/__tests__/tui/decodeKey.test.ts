import { describe, it, expect } from "vitest";
import { decodeKey } from "../../tui/decodeKey.js";

describe("decodeKey", () => {
  describe("enter", () => {
    it("should decode carriage return", () => {
      expect(decodeKey("\r")).toEqual({ type: "enter" });
    });

    it("should decode newline", () => {
      expect(decodeKey("\n")).toEqual({ type: "enter" });
    });
  });

  describe("backspace", () => {
    it("should decode DEL (0x7f)", () => {
      expect(decodeKey("\x7f")).toEqual({ type: "backspace" });
    });

    it("should decode backspace (0x08)", () => {
      expect(decodeKey("\b")).toEqual({ type: "backspace" });
    });
  });

  describe("tab", () => {
    it("should decode tab", () => {
      expect(decodeKey("\t")).toEqual({ type: "tab" });
    });
  });

  describe("escape", () => {
    it("should decode escape", () => {
      expect(decodeKey("\x1b")).toEqual({ type: "escape" });
    });
  });

  describe("arrow keys", () => {
    it("should decode arrow up", () => {
      expect(decodeKey("\x1b[A")).toEqual({ type: "up" });
    });

    it("should decode arrow down", () => {
      expect(decodeKey("\x1b[B")).toEqual({ type: "down" });
    });

    it("should decode arrow right", () => {
      expect(decodeKey("\x1b[C")).toEqual({ type: "right" });
    });

    it("should decode arrow left", () => {
      expect(decodeKey("\x1b[D")).toEqual({ type: "left" });
    });
  });

  describe("home", () => {
    it("should decode home (CSI H)", () => {
      expect(decodeKey("\x1b[H")).toEqual({ type: "home" });
    });

    it("should decode home (CSI 1~)", () => {
      expect(decodeKey("\x1b[1~")).toEqual({ type: "home" });
    });

    it("should decode home (SS3 H)", () => {
      expect(decodeKey("\x1bOH")).toEqual({ type: "home" });
    });
  });

  describe("end", () => {
    it("should decode end (CSI F)", () => {
      expect(decodeKey("\x1b[F")).toEqual({ type: "end" });
    });

    it("should decode end (CSI 4~)", () => {
      expect(decodeKey("\x1b[4~")).toEqual({ type: "end" });
    });

    it("should decode end (SS3 F)", () => {
      expect(decodeKey("\x1bOF")).toEqual({ type: "end" });
    });
  });

  describe("delete", () => {
    it("should decode delete (CSI 3~)", () => {
      expect(decodeKey("\x1b[3~")).toEqual({ type: "delete" });
    });
  });

  describe("newline (Shift+Enter)", () => {
    it("should decode Shift+Enter", () => {
      const result = decodeKey("\x1b[27;2;13~");
      expect(result.type).toBe("newline");
    });
  });

  describe("ctrl keys", () => {
    it("should decode Ctrl+A", () => {
      expect(decodeKey("\x01")).toEqual({ type: "ctrl", key: "a" });
    });

    it("should decode Ctrl+C", () => {
      expect(decodeKey("\x03")).toEqual({ type: "ctrl", key: "c" });
    });

    it("should decode Ctrl+E", () => {
      expect(decodeKey("\x05")).toEqual({ type: "ctrl", key: "e" });
    });

    it("should decode Ctrl+K", () => {
      expect(decodeKey("\x0b")).toEqual({ type: "ctrl", key: "k" });
    });

    it("should decode Ctrl+U", () => {
      expect(decodeKey("\x15")).toEqual({ type: "ctrl", key: "u" });
    });

    it("should decode Ctrl+W", () => {
      expect(decodeKey("\x17")).toEqual({ type: "ctrl", key: "w" });
    });

    it("should decode Ctrl+Z", () => {
      expect(decodeKey("\x1a")).toEqual({ type: "ctrl", key: "z" });
    });
  });

  describe("char", () => {
    it("should decode printable characters", () => {
      expect(decodeKey("a")).toEqual({ type: "char", value: "a" });
      expect(decodeKey("Z")).toEqual({ type: "char", value: "Z" });
      expect(decodeKey(" ")).toEqual({ type: "char", value: " " });
      expect(decodeKey("!")).toEqual({ type: "char", value: "!" });
    });
  });

  describe("paste", () => {
    it("should decode bracketed paste", () => {
      const result = decodeKey("\x1b[200~hello world\x1b[201~");
      expect(result).toEqual({ type: "paste", text: "hello world" });
    });

    it("should decode multi-char printable as paste", () => {
      const result = decodeKey("hello");
      expect(result).toEqual({ type: "paste", text: "hello" });
    });

    it("should decode multiline paste", () => {
      const result = decodeKey("line1\nline2");
      expect(result).toEqual({ type: "paste", text: "line1\nline2" });
    });
  });

  describe("unknown", () => {
    it("should return unknown for unrecognized sequences", () => {
      const result = decodeKey("\x00\x01");
      expect(result.type).toBe("unknown");
    });
  });
});