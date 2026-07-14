import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { TerminalSession } from "../../frontend/workspace/terminal.js";
import { TerminalManager } from "../../frontend/daemon/terminal-manager.js";

/** Espera a que el output del PTY contenga `needle` (o falla por timeout). */
function waitFor(term: TerminalSession, needle: string, ms = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const off = term.onData((d) => {
      buf += d;
      if (buf.includes(needle)) {
        off();
        resolve(buf);
      }
    });
    setTimeout(() => {
      off();
      reject(new Error(`timeout esperando "${needle}"; vi: ${JSON.stringify(buf.slice(-160))}`));
    }, ms);
  });
}

describe("TerminalSession", () => {
  const alive: TerminalSession[] = [];
  const track = (t: TerminalSession): TerminalSession => (alive.push(t), t);
  afterEach(() => {
    for (const t of alive.splice(0)) t.kill();
  });

  it("spawnea un shell y streamea el output de un comando", async () => {
    const term = track(new TerminalSession({ cwd: tmpdir(), shell: "/bin/sh" }));
    term.write("printf MARK-%s\\\\n 123\n");
    const out = await waitFor(term, "MARK-123");
    expect(out).toContain("MARK-123");
  });

  it("acumula scrollback para el replay", async () => {
    const term = track(new TerminalSession({ cwd: tmpdir(), shell: "/bin/sh" }));
    term.write("printf REPLAY-OK\\\\n\n");
    await waitFor(term, "REPLAY-OK");
    expect(term.replay).toContain("REPLAY-OK");
  });

  it("kill() marca no-vivo y es idempotente", async () => {
    const term = track(new TerminalSession({ cwd: tmpdir(), shell: "/bin/sh" }));
    expect(term.alive).toBe(true);
    term.kill();
    expect(term.alive).toBe(false);
    expect(() => term.kill()).not.toThrow(); // segundo kill: no-op
    term.write("nada"); // write tras kill: no rompe
  });
});

describe("TerminalManager", () => {
  const mgr = new TerminalManager();
  afterEach(() => mgr.killAll());

  it("getOrCreate reusa el MISMO PTY mientras viva (persistencia)", () => {
    const a = mgr.getOrCreate("s1", tmpdir());
    const b = mgr.getOrCreate("s1", tmpdir());
    expect(b).toBe(a); // no spawnea uno nuevo
  });

  it("kill descarta el PTY: el próximo getOrCreate spawnea otro", () => {
    const a = mgr.getOrCreate("s2", tmpdir());
    mgr.kill("s2");
    expect(a.alive).toBe(false);
    const b = mgr.getOrCreate("s2", tmpdir());
    expect(b).not.toBe(a); // instancia nueva
    expect(b.alive).toBe(true);
  });

  it("killAll mata todo", () => {
    const a = mgr.getOrCreate("s3", tmpdir());
    const b = mgr.getOrCreate("s4", tmpdir());
    mgr.killAll();
    expect(a.alive).toBe(false);
    expect(b.alive).toBe(false);
  });
});
