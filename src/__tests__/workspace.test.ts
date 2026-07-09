import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { mkdtemp, rm, writeFile, stat, realpath, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { createWorkspace } from "../workspace.js";
import type { ResolvedWorktreeConfig } from "../config.js";

const execFileAsync = promisify(execFile);

const CFG = (over: Partial<ResolvedWorktreeConfig> = {}): ResolvedWorktreeConfig => ({
  dir: ".omega/worktrees",
  baseBranch: "",
  copy: [],
  command: "",
  removeCommand: "",
  ...over,
});

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
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

async function branchExists(dir: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: dir });
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

  it("modo compartido: cwd = baseDir, sin aislamiento", async () => {
    const ws = await createWorkspace({ baseDir: base, sessionId: "s1", config: CFG() });
    expect(ws.cwd).toBe(base);
    expect(ws.isolated).toBe(false);
    expect(ws.branch).toBeUndefined();
    await ws.dispose();
  });

  it("aislado: crea un worktree con branch nombrada en la ruta configurada", async () => {
    await initRepo(base);
    const ws = await createWorkspace({
      baseDir: base, sessionId: "abc123", isolate: true, branch: "feat/x", config: CFG(),
    });

    expect(ws.isolated).toBe(true);
    expect(ws.branch).toBe("feat/x");
    expect(ws.cwd).toBe(join(base, ".omega", "worktrees", "feat/x"));
    expect(await exists(join(ws.cwd, "README.md"))).toBe(true);
    expect(await branchExists(base, "feat/x")).toBe(true); // branch real, no detached

    await ws.dispose();
    expect(await exists(ws.cwd)).toBe(false);
    // La branch se CONSERVA tras dispose (por si querés PR-earla).
    expect(await branchExists(base, "feat/x")).toBe(true);
  });

  it("sin branch explícita, nombra omega/<idcorto>", async () => {
    await initRepo(base);
    const ws = await createWorkspace({ baseDir: base, sessionId: "deadbeef1234", isolate: true, config: CFG() });
    expect(ws.branch).toBe("omega/deadbeef");
    await ws.dispose();
  });

  it("respeta la base branch al crear", async () => {
    await initRepo(base);
    // Rama 'dev' con un archivo que main no tiene
    await execFileAsync("git", ["checkout", "-q", "-b", "dev"], { cwd: base });
    await writeFile(join(base, "solo-dev.txt"), "x", "utf-8");
    await execFileAsync("git", ["add", "-A"], { cwd: base });
    await execFileAsync("git", ["commit", "-q", "-m", "dev"], { cwd: base });
    await execFileAsync("git", ["checkout", "-q", "main"], { cwd: base });

    const ws = await createWorkspace({
      baseDir: base, sessionId: "s", isolate: true, branch: "feat/y", base: "dev", config: CFG(),
    });
    expect(await exists(join(ws.cwd, "solo-dev.txt"))).toBe(true); // heredó de dev
    await ws.dispose();
  });

  it("copia los archivos de config al worktree (worktree.copy)", async () => {
    await initRepo(base);
    await writeFile(join(base, ".env"), "SECRET=1\n", "utf-8"); // gitignoreado, no commiteado
    const ws = await createWorkspace({
      baseDir: base, sessionId: "s", isolate: true, branch: "feat/z", config: CFG({ copy: [".env"] }),
    });
    expect(await exists(join(ws.cwd, ".env"))).toBe(true);
    expect(await readFile(join(ws.cwd, ".env"), "utf-8")).toContain("SECRET=1");
    await ws.dispose();
  });

  it("hook: worktree.command puebla el path que Omega fija", async () => {
    await initRepo(base);
    const ws = await createWorkspace({
      baseDir: base, sessionId: "s", isolate: true, branch: "feat/hook",
      config: CFG({
        command: 'git worktree add -b "$OMEGA_WORKTREE_BRANCH" "$OMEGA_WORKTREE_PATH" && touch "$OMEGA_WORKTREE_PATH/HOOKED"',
      }),
    });
    expect(ws.cwd).toBe(join(base, ".omega", "worktrees", "feat/hook"));
    expect(await exists(join(ws.cwd, "HOOKED"))).toBe(true); // el hook corrió
    expect(await exists(join(ws.cwd, "README.md"))).toBe(true); // y es un worktree real
    await ws.dispose();
  });

  it("aislado en un dir no-git (sin command): cae a compartido", async () => {
    const ws = await createWorkspace({ baseDir: base, sessionId: "s", isolate: true, config: CFG() });
    expect(ws.isolated).toBe(false);
    expect(ws.cwd).toBe(base);
    await ws.dispose();
  });
});
