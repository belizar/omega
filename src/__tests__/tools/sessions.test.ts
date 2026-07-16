import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionsTool } from "../../tools/sessions.js";

describe("SessionsTool", () => {
  let dir: string, indexPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omega-sessions-"));
    // dos transcripts
    const t1 = join(dir, "s1.json");
    writeFileSync(t1, JSON.stringify({ messages: [
      { role: "user", content: "arreglá el bug de threads" },
      { role: "assistant", content: [{ type: "text", text: "Listo, lo arreglé." }, { type: "tool_use", name: "edit" }] },
      { role: "user", content: "no, eso está mal, hacelo de nuevo" },
    ] }));
    const t2 = join(dir, "s2.json");
    writeFileSync(t2, JSON.stringify({ messages: [{ role: "user", content: "test de prueba de omega" }] }));
    indexPath = join(dir, "index.json");
    writeFileSync(indexPath, JSON.stringify({ sessions: [
      { id: "aaaa1111-x", title: "MED-1 threads", project: "/w/Medra/medra-functions/med-1", sessionFile: t1, lastActive: 200, archived: false },
      { id: "bbbb2222-x", title: "prueba", project: "/w/omega/test", sessionFile: t2, lastActive: 100, archived: false },
      { id: "cccc3333-x", title: "vieja archivada", project: "/w/x", sessionFile: t1, lastActive: 50, archived: true },
    ] }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("list — sesiones (recientes primero, salta archivadas)", async () => {
    const out = await new SessionsTool(indexPath).execute({ action: "list" });
    expect(out).toContain("MED-1 threads");
    expect(out).toContain("prueba");
    expect(out).not.toContain("archivada"); // archived → fuera
    expect(out.indexOf("MED-1")).toBeLessThan(out.indexOf("prueba")); // más reciente primero
  });

  it("list — filtra por proyecto", async () => {
    const out = await new SessionsTool(indexPath).execute({ action: "list", project: "medra-functions" });
    expect(out).toContain("MED-1 threads");
    expect(out).not.toContain("prueba");
  });

  it("search — encuentra correcciones con la sesión de origen", async () => {
    const out = await new SessionsTool(indexPath).execute({ action: "search", query: "eso está mal" });
    expect(out).toContain("aaaa1111"); // short id de la sesión con la corrección
    expect(out.toLowerCase()).toContain("eso está mal");
  });

  it("read — aplana el transcript, omite tool outputs, marca tool_use", async () => {
    const out = await new SessionsTool(indexPath).execute({ action: "read", id: "aaaa1111" });
    expect(out).toContain("user: arreglá el bug");
    expect(out).toContain("assistant: Listo");
    expect(out).toContain("usó tool: edit");
  });

  it("read — id desconocido", async () => {
    const out = await new SessionsTool(indexPath).execute({ action: "read", id: "nope" });
    expect(out).toContain("No encontré");
  });
});
