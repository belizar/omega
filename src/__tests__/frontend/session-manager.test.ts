import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { mkdtemp, rm, writeFile, stat, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { SessionManager } from "../../frontend/session-manager.js";
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

/**
 * Config mínima: solo los campos que toca el stack por-sesión (createAgentStack +
 * Session + Screen + WebFrontend). El llmProvider nunca se usa porque no mandamos
 * input → no corre ningún turno → no hay llamada al LLM.
 */
function fakeBase(): CoreServices {
  const config = {
    outlineThreshold: 200,
    model: "test-model",
    maxTokens: 100,
    bashTimeoutMs: 1000,
    maxContextTokens: 100_000,
    screenPadding: 6,
    classifierMode: "off",
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

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "omega-sm-")));
    sessionsDir = join(baseDir, "sessions-store");
    await initRepo(baseDir);
    mgr = new SessionManager(fakeBase(), { baseDir, sessionsDir });
  });

  afterEach(async () => {
    await mgr.disposeAll();
    await rm(baseDir, { recursive: true, force: true });
  });

  it("crea una sesión compartida y la lista", async () => {
    const h = await mgr.create({ title: "primera" });
    expect(mgr.has(h.id)).toBe(true);
    expect(h.workspace.isolated).toBe(false);
    expect(h.workspace.cwd).toBe(baseDir);

    const list = mgr.list();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("primera");
    expect(list[0].live).toBe(true);
  });

  it("cada sesión worktree tiene su propio cwd aislado", async () => {
    const a = await mgr.create({ worktree: true });
    const b = await mgr.create({ worktree: true });

    expect(a.id).not.toBe(b.id);
    expect(a.workspace.cwd).not.toBe(b.workspace.cwd);
    expect(a.workspace.isolated).toBe(true);
    expect(await exists(a.workspace.cwd)).toBe(true);
    expect(mgr.list()).toHaveLength(2);
  });

  it("las sesiones no comparten frontend ni toolRegistry (hubs independientes)", async () => {
    const a = await mgr.create();
    const b = await mgr.create();
    expect(a.frontend).not.toBe(b.frontend);
    expect(a.toolRegistry).not.toBe(b.toolRegistry);
  });

  it("remove baja la sesión y limpia su worktree", async () => {
    const h = await mgr.create({ worktree: true });
    const cwd = h.workspace.cwd;
    expect(await exists(cwd)).toBe(true);

    await mgr.remove(h.id);
    expect(mgr.has(h.id)).toBe(false);
    expect(mgr.list()).toHaveLength(0);
    expect(await exists(cwd)).toBe(false); // worktree removido
  });

  it("remove de un id inexistente es noop", async () => {
    await mgr.remove("no-existe"); // no debe reventar
    expect(mgr.list()).toHaveLength(0);
  });
});
