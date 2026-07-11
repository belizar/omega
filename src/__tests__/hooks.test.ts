import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { HookRunner } from "../hooks.js";

/** Los hooks son fire-and-forget (spawn async): esperamos a que el efecto aparezca. */
async function waitFor(fn: () => Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
const exists = (p: string) => stat(p).then(() => true).catch(() => false);
const q = (s: string) => JSON.stringify(s); // path entre comillas para el shell

describe("HookRunner", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "omega-hooks-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("dispara el command de un evento (fire-and-forget)", async () => {
    const marker = join(dir, "fired");
    new HookRunner({ "turn-end": [{ command: `touch ${q(marker)}` }] }).fire("turn-end", { cwd: dir });
    expect(await waitFor(() => exists(marker))).toBe(true);
  });

  it("le pasa el JSON del payload por stdin (con el event adentro)", async () => {
    const out = join(dir, "payload.json");
    new HookRunner({ "ask-user": [{ command: `cat > ${q(out)}` }] })
      .fire("ask-user", { sessionId: "abc", cwd: dir, question: "¿qué leads?" });
    expect(await waitFor(() => exists(out))).toBe(true);
    const body = JSON.parse(await readFile(out, "utf-8"));
    expect(body).toMatchObject({ event: "ask-user", sessionId: "abc", question: "¿qué leads?" });
  });

  it("expone env vars de conveniencia (OMEGA_EVENT, OMEGA_CWD)", async () => {
    const out = join(dir, "env.txt");
    new HookRunner({ "turn-end": [{ command: `printf '%s|%s' "$OMEGA_EVENT" "$OMEGA_CWD" > ${q(out)}` }] })
      .fire("turn-end", { cwd: dir });
    expect(await waitFor(() => exists(out))).toBe(true);
    expect(await readFile(out, "utf-8")).toBe(`turn-end|${dir}`);
  });

  it("matcher filtra por nombre de tool", async () => {
    const hit = join(dir, "edited");
    const r = new HookRunner({ "post-tool": [{ matcher: "edit", command: `touch ${q(hit)}` }] });
    r.fire("post-tool", { cwd: dir }, { toolName: "bash" }); // no matchea → no dispara
    // Damos tiempo a que un (inexistente) spawn de bash corriera, y confirmamos que NO.
    await new Promise((res) => setTimeout(res, 150));
    expect(await exists(hit)).toBe(false);
    r.fire("post-tool", { cwd: dir }, { toolName: "edit" }); // matchea → dispara
    expect(await waitFor(() => exists(hit))).toBe(true);
  });

  it("isEmpty: true sin config; load de archivo inexistente → runner vacío", () => {
    expect(new HookRunner().isEmpty).toBe(true);
    expect(HookRunner.load(join(dir, "no-existe.json")).isEmpty).toBe(true);
  });

  it("load lee hooks.json (soporta {evento:[…]} y {hooks:{…}})", async () => {
    const p1 = join(dir, "h1.json");
    await writeFile(p1, JSON.stringify({ "turn-end": [{ command: "true" }] }), "utf-8");
    expect(HookRunner.load(p1).isEmpty).toBe(false);

    const p2 = join(dir, "h2.json");
    await writeFile(p2, JSON.stringify({ hooks: { "ask-user": [{ command: "true" }] } }), "utf-8");
    expect(HookRunner.load(p2).isEmpty).toBe(false);
  });
});
