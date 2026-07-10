import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { mkdtemp, rm, writeFile, stat, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { SessionManager } from "../../frontend/session-manager.js";
import { SessionIndex } from "../../frontend/session-index.js";
import type { CoreServices } from "../../core.js";

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

function fakeBase(): CoreServices {
  const config = {
    outlineThreshold: 200,
    model: "test-model",
    maxTokens: 100,
    bashTimeoutMs: 1000,
    maxContextTokens: 100_000,
    screenPadding: 6,
    classifierMode: "off",
    worktree: { dir: ".omega/worktrees", baseBranch: "", copy: [], command: "", removeCommand: "" },
  } as unknown as CoreServices["config"];

  return {
    config,
    classifier: undefined,
    visionAskTool: null,
    skills: [],
    systemPrompt: "test prompt",
    llmProvider: {} as CoreServices["llmProvider"],
  } as unknown as CoreServices;
}

describe("SessionManager", () => {
  let baseDir: string;
  let sessionsDir: string;
  let mgr: SessionManager;
  let indexPath: string;

  function newMgr(): SessionManager {
    // Índice hermético: NO tocar el ~/.omega real.
    return new SessionManager(fakeBase(), {
      baseDir,
      sessionsDir,
      index: new SessionIndex(indexPath),
    });
  }

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "omega-sm-")));
    sessionsDir = join(baseDir, "sessions-store");
    indexPath = join(baseDir, "index.json");
    await initRepo(baseDir);
    mgr = newMgr();
  });

  afterEach(async () => {
    await mgr.disposeAll();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("crea una sesión compartida y la lista como viva", async () => {
    const h = await mgr.create({ title: "primera" });
    expect(mgr.has(h.id)).toBe(true);
    expect(h.workspace.isolated).toBe(false);

    const list = mgr.listAll();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("primera");
    expect(list[0].live).toBe(true);
  });

  it("cada sesión worktree tiene su propio cwd aislado", async () => {
    const a = await mgr.create({ worktree: true });
    const b = await mgr.create({ worktree: true });
    expect(a.workspace.cwd).not.toBe(b.workspace.cwd);
    expect(a.workspace.isolated).toBe(true);
    expect(await exists(a.workspace.cwd)).toBe(true);
    expect(mgr.listAll()).toHaveLength(2);
  });

  it("las sesiones no comparten frontend ni toolRegistry", async () => {
    const a = await mgr.create();
    const b = await mgr.create();
    expect(a.frontend).not.toBe(b.frontend);
    expect(a.toolRegistry).not.toBe(b.toolRegistry);
  });

  it("detach DUERME la sesión pero conserva el worktree (revivible)", async () => {
    const h = await mgr.create({ worktree: true });
    const cwd = h.workspace.cwd;

    await mgr.detach(h.id);
    expect(mgr.has(h.id)).toBe(false); // ya no está viva
    expect(await exists(cwd)).toBe(true); // pero el worktree SIGUE en disco

    // Sigue listada como dormida
    const list = mgr.listAll();
    expect(list).toHaveLength(1);
    expect(list[0].live).toBe(false);
  });

  it("revive trae de vuelta una sesión dormida con su transcript", async () => {
    const h = await mgr.create({ title: "con-historia", worktree: true });
    h.session.addUserMessage("acordate de esto"); // persiste al .json
    const cwd = h.workspace.cwd;
    await mgr.detach(h.id);

    const revived = await mgr.revive(h.id);
    expect(revived).not.toBeNull();
    expect(revived!.id).toBe(h.id);
    expect(revived!.workspace.cwd).toBe(cwd); // re-attacheó el MISMO worktree
    // El transcript volvió del disco
    const texts = JSON.stringify(revived!.session.messages);
    expect(texts).toContain("acordate de esto");
    expect(mgr.listAll()[0].live).toBe(true);
  });

  it("las sesiones sobreviven a un 'reinicio' del manager (índice en disco)", async () => {
    const h = await mgr.create({ title: "persistente" });
    h.session.addUserMessage("hola de ayer");
    await mgr.disposeAll(); // "apagar el server"

    // Manager nuevo, mismo índice en disco → ve la sesión dormida
    const mgr2 = newMgr();
    const list = mgr2.listAll();
    expect(list.some((s) => s.id === h.id)).toBe(true);
    expect(list.find((s) => s.id === h.id)!.live).toBe(false);

    const revived = await mgr2.revive(h.id);
    expect(JSON.stringify(revived!.session.messages)).toContain("hola de ayer");
    await mgr2.disposeAll();
  });

  it("revive de un id desconocido devuelve null", async () => {
    expect(await mgr.revive("no-existe")).toBeNull();
  });

  it("attach: se engancha a un worktree existente y NO lo borra al detach", async () => {
    // Tu flujo: el worktree ya existe (lo hiciste con tree.sh, acá lo simulamos).
    const ext = join(baseDir, "external-wt");
    await execFileAsync("git", ["worktree", "add", "-b", "feat/mine", ext], { cwd: baseDir });

    const h = await mgr.create({ mode: "attach", cwd: ext });
    expect(h.workspace.cwd).toBe(ext);
    expect(h.workspace.isolated).toBe(true);
    expect(h.workspace.branch).toBe("feat/mine"); // detectó la branch del worktree

    await mgr.detach(h.id);
    expect(await exists(ext)).toBe(true); // prestado (owned=false) → intacto
  });

  it("attach a un directorio inexistente tira error", async () => {
    await expect(
      mgr.create({ mode: "attach", cwd: join(baseDir, "no-existe") }),
    ).rejects.toThrow();
  });
});
