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
    expect(screen.getStatus()).toBeTruthy();

    // Let it tick once so the frame changes
    vi.advanceTimersByTime(100);
    const beforeSecondStart = screen.getStatus();

    // Second start should be no-op: frame shouldn't change
    spinner.start();
    expect(screen.getStatus()).toBe(beforeSecondStart);
  });

  it("should change frame on each timer tick", () => {
    const spinner = new Spinner(screen as any);
    spinner.start();
    const first = screen.getStatus();

    vi.advanceTimersByTime(100);
    const second = screen.getStatus();

    // The frame should have changed (different character)
    expect(second).not.toBe(first);
  });

  it("should be safe to call stop without start", () => {
    const spinner = new Spinner(screen as any);
    spinner.stop(); // should not throw
    expect(screen.getStatus()).toBeNull();
  });

  it("should restart correctly after stop/start cycle", () => {
    const spinner = new Spinner(screen as any);

    // Start, let it run a few ticks
    spinner.start();
    vi.advanceTimersByTime(300);
    expect(screen.getStatus()).toBeTruthy();
    expect(screen.getStatus()).toContain("Pensando");

    // Stop
    spinner.stop();
    expect(screen.getStatus()).toBeNull();

    // Start again, should work
    spinner.start();
    vi.advanceTimersByTime(100);
    expect(screen.getStatus()).toBeTruthy();
    expect(screen.getStatus()).toContain("Pensando");

    // Let it run a few more ticks, should still be alive
    vi.advanceTimersByTime(300);
    expect(screen.getStatus()).toBeTruthy();
    expect(screen.getStatus()).toContain("Pensando");

    spinner.stop();
    expect(screen.getStatus()).toBeNull();
  });

  it("should keep running across multiple ticks", () => {
    const spinner = new Spinner(screen as any);
    spinner.start();

    // Let it run for 10 ticks
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100);
      expect(screen.getStatus()).toBeTruthy();
      expect(screen.getStatus()).toContain("Pensando");
    }

    spinner.stop();
    expect(screen.getStatus()).toBeNull();
  });
});