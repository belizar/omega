import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { mkdtemp, rm, writeFile, stat, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { createWorkspace } from "../workspace.js";

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "hola\n", "utf-8");
  await execFileAsync("git", ["add", "-A"], { cwd: dir });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("createWorkspace", () => {
  let base: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), "omega-ws-")));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("modo compartido: cwd = baseDir, sin aislamiento, dispose es noop", async () => {
    const ws = await createWorkspace({ baseDir: base, sessionId: "s1" });
    expect(ws.cwd).toBe(base);
    expect(ws.isolated).toBe(false);
    await ws.dispose(); // no debe reventar
  });

  it("modo worktree en un repo git: crea un worktree dedicado y lo limpia", async () => {
    await initRepo(base);
    const ws = await createWorkspace({ baseDir: base, sessionId: "abc123", worktree: true });

    expect(ws.isolated).toBe(true);
    expect(ws.cwd).toBe(join(base, ".omega", "worktrees", "abc123"));
    expect(await exists(join(ws.cwd, "README.md"))).toBe(true); // heredó el checkout

    // El worktree figura en git
    const { stdout } = await execFileAsync("git", ["worktree", "list"], { cwd: base });
    expect(stdout).toContain("abc123");

    await ws.dispose();
    expect(await exists(ws.cwd)).toBe(false);
    // dispose es idempotente
    await ws.dispose();
  });

  it("dos sesiones worktree del mismo HEAD conviven (detached, no chocan de rama)", async () => {
    await initRepo(base);
    const a = await createWorkspace({ baseDir: base, sessionId: "aaa", worktree: true });
    const b = await createWorkspace({ baseDir: base, sessionId: "bbb", worktree: true });

    expect(a.cwd).not.toBe(b.cwd);
    // Aislamiento: un archivo en A no aparece en B
    await writeFile(join(a.cwd, "solo-en-a.txt"), "x", "utf-8");
    expect(await exists(join(a.cwd, "solo-en-a.txt"))).toBe(true);
    expect(await exists(join(b.cwd, "solo-en-a.txt"))).toBe(false);

    await a.dispose();
    await b.dispose();
  });

  it("worktree pedido en un dir no-git: cae a compartido sin reventar", async () => {
    const ws = await createWorkspace({ baseDir: base, sessionId: "s2", worktree: true });
    expect(ws.isolated).toBe(false);
    expect(ws.cwd).toBe(base);
    await ws.dispose();
  });
});
