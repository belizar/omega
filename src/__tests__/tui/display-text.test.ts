import { describe, it, expect, vi, beforeEach } from "vitest";
import { DisplayAssistantText, DisplayToolCall, DisplayToolResult } from "../../tui/components/display-text.js";

// ── Mock Screen ──────────────────────────────────────────────────────────────

class MockScreen {
  #aboveLines: string[] = [];
  #ephemeralText = "";
  #ephemeralCleared = false;

  printAbove(text: string): void {
    this.#aboveLines.push(text);
  }

  writeEphemeral(text: string): void {
    this.#ephemeralText = text;
  }

  clearEphemeral(): void {
    this.#ephemeralCleared = true;
    this.#ephemeralText = "";
  }

  getAboveLines(): string[] {
    return [...this.#aboveLines];
  }

  getLastAbove(): string {
    return this.#aboveLines[this.#aboveLines.length - 1] ?? "";
  }

  getEphemeral(): string {
    return this.#ephemeralText;
  }

  wasEphemeralCleared(): boolean {
    return this.#ephemeralCleared;
  }
}

// ── DisplayAssistantText ─────────────────────────────────────────────────────

describe("DisplayAssistantText", () => {
  let screen: MockScreen;
  let display: DisplayAssistantText;

  beforeEach(() => {
    screen = new MockScreen();
    display = new DisplayAssistantText(screen as any);
  });

  it("should print text via printAbove", () => {
    display.display("Hello world");
    expect(screen.getLastAbove()).toContain("Hello world");
  });

  it("should handle streaming: accumulate partial lines", () => {
    display.displayStream("hello ");
    expect(screen.getEphemeral()).toContain("hello ");

    display.displayStream("world\nnext line");
    // "hello world" should have been flushed to above
    expect(screen.getAboveLines().length).toBeGreaterThanOrEqual(1);
    // "next line" should remain ephemeral
    expect(screen.getEphemeral()).toContain("next line");
  });

  it("should flush remaining buffer on endStream", () => {
    display.displayStream("unfinished");
    display.endStream();

    expect(screen.wasEphemeralCleared()).toBe(true);
    expect(screen.getLastAbove()).toContain("unfinished");
  });

  it("should handle endStream without prior streaming", () => {
    display.endStream(); // should not throw
    expect(screen.wasEphemeralCleared()).toBe(false);
  });
});

// ── DisplayToolCall ──────────────────────────────────────────────────────────

describe("DisplayToolCall", () => {
  let screen: MockScreen;
  let display: DisplayToolCall;

  beforeEach(() => {
    screen = new MockScreen();
    display = new DisplayToolCall(screen as any);
  });

  it("should format read tool call", () => {
    display.call("read", { path: "src/index.ts" }, false);
    expect(screen.getLastAbove()).toContain("read src/index.ts");
  });

  it("should format write tool call", () => {
    display.call("write", { path: "output.txt" }, false);
    expect(screen.getLastAbove()).toContain("write output.txt");
  });

  it("should format edit tool call", () => {
    display.call("edit", { path: "file.ts" }, false);
    expect(screen.getLastAbove()).toContain("edit file.ts");
  });

  it("should format bash tool call", () => {
    display.call("bash", { command: "git status" }, false);
    expect(screen.getLastAbove()).toContain("bash 'git status'");
  });

  it("should truncate long bash commands", () => {
    const longCmd = "x".repeat(100);
    display.call("bash", { command: longCmd }, false);
    const line = screen.getLastAbove();
    expect(line).toContain("...");
    expect(line.length).toBeLessThan(longCmd.length + 20);
  });

  it("should handle unknown tool names", () => {
    display.call("unknown_tool", { someParam: "value" }, false);
    expect(screen.getLastAbove()).toContain("unknown_tool");
  });

  it("should handle null input", () => {
    display.call("bash", null, false);
    expect(screen.getLastAbove()).toContain("bash");
  });
});

// ── DisplayToolResult ────────────────────────────────────────────────────────

describe("DisplayToolResult", () => {
  let screen: MockScreen;
  let display: DisplayToolResult;

  beforeEach(() => {
    screen = new MockScreen();
    display = new DisplayToolResult(screen as any);
  });

  it("should show compact summary for multi-line output", () => {
    display.result("line1\nline2\nline3", false);
    expect(screen.getLastAbove()).toContain("3 líneas");
  });

  it("should show compact summary with char count", () => {
    const long = "x".repeat(2000);
    display.result(long, false);
    expect(screen.getLastAbove()).toContain("2.0K");
  });

  it("should show short single-line output as-is", () => {
    display.result("done", false);
    expect(screen.getLastAbove()).toContain("done");
  });

  it("should show error summary", () => {
    display.result("Error: something went wrong\nmore details", false);
    expect(screen.getLastAbove()).toContain("Error: something went wrong");
  });

  it("should show full output in verbose mode", () => {
    display.result("full\noutput\nhere", true);
    expect(screen.getAboveLines().some((l) => l.includes("full"))).toBe(true);
  });

  it("should show empty for blank output", () => {
    display.result("", false);
    expect(screen.getLastAbove()).toContain("vacío");
  });

  it("should use rawOutput for summary when available", () => {
    display.result("truncated...", false, "full raw output here");
    // rawOutput se usa para el resumen
    expect(screen.getLastAbove()).toContain("full raw output here");
  });
});