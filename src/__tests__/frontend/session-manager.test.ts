import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { mkdtemp, mkdir, rm, writeFile, stat, realpath } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { SessionManager } from "../../frontend/session-manager.js";
import { SessionIndex } from "../../frontend/session-index.js";
import { NotificationHub, AttentionEvent } from "../../frontend/notification-hub.js";
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

  it("asigna project (raíz del repo) y lo expone en listAll", async () => {
    const h = await mgr.create();
    expect(h.project).toBe(baseDir); // detectProject de un repo = su raíz
    expect(mgr.listAll()[0].project).toBe(baseDir);
  });

  it("importExisting descubre sesiones de worktrees y las importa (con su cwd)", async () => {
    // Simulamos tu flujo: un worktree con una sesión de la TUI in-process.
    const wt = join(baseDir, "MED-1234");
    const sdir = join(wt, ".omega", "sessions");
    await mkdir(sdir, { recursive: true });
    await writeFile(
      join(sdir, "sess-abc.json"),
      JSON.stringify({ name: "", messages: [{ role: "user", content: "arreglá el bug" }] }),
      "utf-8",
    );

    const n = await mgr.importExisting([baseDir]);
    expect(n).toBe(1);
    const s = mgr.listAll().find((x) => x.id === "sess-abc");
    expect(s).toBeTruthy();
    expect(s!.cwd).toBe(wt); // apunta al worktree, no al store global
    expect(s!.live).toBe(false); // dormida, revivible

    // Idempotente: no re-importa lo ya indexado.
    expect(await mgr.importExisting([baseDir])).toBe(0);
  });

  it("rename cambia el título de una sesión VIVA (handle + listAll)", async () => {
    const h = await mgr.create({ title: "viejo" });
    const applied = mgr.rename(h.id, "  nombre nuevo  ");
    expect(applied).toBe("nombre nuevo"); // trim
    expect(mgr.listAll().find((s) => s.id === h.id)!.title).toBe("nombre nuevo");
    expect(h.session.name).toBe("nombre nuevo"); // persistido al transcript
  });

  it("rename de una sesión DORMIDA toca el índice y parchea el .json", async () => {
    const h = await mgr.create({ title: "dormila", worktree: true });
    const id = h.id;
    h.session.addUserMessage("algo"); // persiste el .json (una dormida real tiene transcript)
    await mgr.detach(id);

    expect(mgr.rename(id, "renombrada dormida")).toBe("renombrada dormida");
    expect(mgr.listAll().find((s) => s.id === id)!.title).toBe("renombrada dormida");

    // Al revivir, el nombre parcheado en el .json sobrevive (no lo revierte).
    const revived = await mgr.revive(id);
    expect(revived!.session.name).toBe("renombrada dormida");
  });

  it("rename con título vacío no hace nada (null)", async () => {
    const h = await mgr.create({ title: "intacto" });
    expect(mgr.rename(h.id, "   ")).toBeNull();
    expect(mgr.listAll()[0].title).toBe("intacto");
  });

  it("rename de un id desconocido devuelve null", () => {
    expect(mgr.rename("no-existe", "x")).toBeNull();
  });

  it("setArchived esconde/muestra en el flag de listAll (no borra)", async () => {
    const h = await mgr.create({ title: "archivame" });
    expect(mgr.listAll().find((s) => s.id === h.id)!.archived).toBe(false);

    expect(mgr.setArchived(h.id, true)).toBe(true);
    const s = mgr.listAll().find((x) => x.id === h.id);
    expect(s).toBeTruthy(); // sigue en la lista (el cliente la esconde)
    expect(s!.archived).toBe(true);

    expect(mgr.setArchived(h.id, false)).toBe(true);
    expect(mgr.listAll().find((x) => x.id === h.id)!.archived).toBe(false);
  });

  it("setArchived de un id desconocido devuelve false", () => {
    expect(mgr.setArchived("no-existe", true)).toBe(false);
  });

  it("listAll tiene orden ESTABLE (creación) — revivir no mueve la sesión", async () => {
    const a = await mgr.create({ title: "a" });
    const b = await mgr.create({ title: "b" });
    const c = await mgr.create({ title: "c" });
    expect(mgr.listAll().map((s) => s.id)).toEqual([a.id, b.id, c.id]);

    // Dormir 'a' y revivirla NO la manda arriba ni abajo: sigue primera.
    await mgr.detach(a.id);
    await mgr.revive(a.id);
    expect(mgr.listAll().map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  it("reorder persiste el nuevo orden del sidebar", async () => {
    const a = await mgr.create({ title: "a" });
    const b = await mgr.create({ title: "b" });
    const c = await mgr.create({ title: "c" });

    mgr.reorder([c.id, a.id, b.id]);
    expect(mgr.listAll().map((s) => s.id)).toEqual([c.id, a.id, b.id]);

    // Sobrevive a un reinicio del manager (order en el índice en disco).
    await mgr.disposeAll();
    const mgr2 = newMgr();
    expect(mgr2.listAll().map((s) => s.id)).toEqual([c.id, a.id, b.id]);
    await mgr2.disposeAll();
  });

  it("una sesión que termina el turno / pide input emite atención al hub global", async () => {
    const hub = new NotificationHub();
    const got: AttentionEvent[] = [];
    hub.add((line) => got.push(JSON.parse(line)));
    const mgr2 = new SessionManager(fakeBase(), {
      baseDir,
      sessionsDir,
      index: new SessionIndex(join(baseDir, "idx-notif.json")),
      notifHub: hub,
    });
    const h = await mgr2.create({ title: "notifica" });

    // turn-end → evento de atención "turn_end" enriquecido con título/id.
    h.frontend.turnEnded();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "attention", kind: "turn_end", sessionId: h.id, title: "notifica" });

    // ask-user → "ask_user" con la pregunta (onLifecycle dispara sincrónico, antes del await).
    void h.frontend.askUser("¿qué leads?");
    expect(got).toHaveLength(2);
    expect(got[1]).toMatchObject({ kind: "ask_user", question: "¿qué leads?", sessionId: h.id });

    await mgr2.disposeAll();
  });

  it("addNotificationClient devuelve una baja que corta el flujo", async () => {
    const hub = new NotificationHub();
    const got: string[] = [];
    const mgr2 = new SessionManager(fakeBase(), {
      baseDir,
      sessionsDir,
      index: new SessionIndex(join(baseDir, "idx-unsub.json")),
      notifHub: hub,
    });
    const off = mgr2.addNotificationClient((line) => got.push(line));
    const h = await mgr2.create({ title: "x" });
    h.frontend.turnEnded();
    expect(got).toHaveLength(1);
    off(); // baja
    h.frontend.turnEnded();
    expect(got).toHaveLength(1); // ya no recibe
    await mgr2.disposeAll();
  });

  it("rescan recupera transcripts huérfanos si el índice se pierde", async () => {
    const h = await mgr.create({ title: "recuperame" });
    h.session.addUserMessage("mensaje importante");
    await mgr.disposeAll();

    // Índice NUEVO (se perdió el viejo) pero mismo store de transcripts.
    const freshIndex = new SessionIndex(join(baseDir, "fresh-index.json"));
    const mgr2 = new SessionManager(fakeBase(), { baseDir, sessionsDir, index: freshIndex });
    expect(mgr2.listAll()).toHaveLength(0); // el índice nuevo no sabe nada

    const n = await mgr2.rescan();
    expect(n).toBe(1);
    const list = mgr2.listAll();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(h.id);
    // Título derivado del transcript (primer mensaje del usuario)
    expect(list[0].title).toContain("mensaje importante");

    // Y se puede revivir con su historia
    const revived = await mgr2.revive(h.id);
    expect(JSON.stringify(revived!.session.messages)).toContain("mensaje importante");
    await mgr2.disposeAll();
  });
});
