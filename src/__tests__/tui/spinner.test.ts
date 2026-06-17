import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Spinner } from "../../tui/components/spinner.js";

// ── Mock Screen ──────────────────────────────────────────────────────────────

class MockScreen {
  #status: string | null = null;

  setStatus(text: string | null): void {
    this.#status = text;
  }

  getStatus(): string | null {
    return this.#status;
  }
}

describe("Spinner", () => {
  let screen: MockScreen;

  beforeEach(() => {
    vi.useFakeTimers();
    screen = new MockScreen();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should set status on start", () => {
    const spinner = new Spinner(screen as any);
    spinner.start();
    vi.advanceTimersByTime(100); // el setInterval corre cada 100ms
    expect(screen.getStatus()).toBeTruthy();
    expect(screen.getStatus()).toContain("Pensando");
  });

  it("should clear status on stop", () => {
    const spinner = new Spinner(screen as any);
    spinner.start();
    spinner.stop();
    expect(screen.getStatus()).toBeNull();
  });

  it("should not start a second timer if already running", () => {
    const spinner = new Spinner(screen as any);
    spinner.start();
    const firstStatus = screen.getStatus();
    spinner.start(); // should be no-op
    expect(screen.getStatus()).toBe(firstStatus);
  });

  it("should change frame on each timer tick", () => {
    const spinner = new Spinner(screen as any);
    spinner.start();
    const firstStatus = screen.getStatus();

    vi.advanceTimersByTime(100);
    const secondStatus = screen.getStatus();

    // The frame should have changed (different character)
    expect(secondStatus).not.toBe(firstStatus);
  });

  it("should be safe to call stop without start", () => {
    const spinner = new Spinner(screen as any);
    spinner.stop(); // should not throw
    expect(screen.getStatus()).toBeNull();
  });
});