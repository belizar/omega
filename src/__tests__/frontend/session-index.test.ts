import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionIndex, IndexEntry } from "../../frontend/session-index.js";

function entry(over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    id: "id-" + Math.round(over.lastActive ?? 1),
    title: "t",
    project: "/repo",
    sessionFile: "/repo/.omega/sessions/x.json",
    cwd: "/repo",
    isolated: false,
    createdAt: 1,
    lastActive: 1,
    ...over,
  };
}

describe("SessionIndex", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omega-idx-"));
    path = join(dir, "nested", "index.json"); // nested → prueba el mkdir recursivo
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("upsert persiste al disco y se relee en una instancia nueva", async () => {
    const a = new SessionIndex(path);
    a.upsert(entry({ id: "s1", title: "primera" }));
    expect(existsSync(path)).toBe(true);

    // Instancia nueva lee del disco → sobrevive al "reinicio"
    const b = new SessionIndex(path);
    expect(b.get("s1")?.title).toBe("primera");
  });

  it("touch actualiza lastActive y título", () => {
    const idx = new SessionIndex(path);
    idx.upsert(entry({ id: "s1", lastActive: 10 }));
    idx.touch("s1", 99, "renombrada");
    expect(idx.get("s1")?.lastActive).toBe(99);
    expect(idx.get("s1")?.title).toBe("renombrada");
  });

  it("remove borra la entrada", () => {
    const idx = new SessionIndex(path);
    idx.upsert(entry({ id: "s1" }));
    idx.remove("s1");
    expect(idx.get("s1")).toBeUndefined();
    expect(new SessionIndex(path).get("s1")).toBeUndefined();
  });

  it("forProject filtra por baseDir y ordena por lastActive desc", () => {
    const idx = new SessionIndex(path);
    idx.upsert(entry({ id: "a", project: "/repo1", lastActive: 1 }));
    idx.upsert(entry({ id: "b", project: "/repo1", lastActive: 3 }));
    idx.upsert(entry({ id: "c", project: "/repo2", lastActive: 2 }));

    const r1 = idx.forProject("/repo1");
    expect(r1.map((e) => e.id)).toEqual(["b", "a"]); // 3 antes que 1
    expect(idx.forProject("/repo2").map((e) => e.id)).toEqual(["c"]);
  });

  it("un índice corrupto no revienta (arranca vacío)", async () => {
    await (await import("fs/promises")).mkdir(join(dir, "nested"), { recursive: true });
    await (await import("fs/promises")).writeFile(path, "{ no es json", "utf-8");
    const idx = new SessionIndex(path); // no debe tirar
    expect(idx.all()).toEqual([]);
    // y puede escribir de nuevo, pisando lo corrupto
    idx.upsert(entry({ id: "s1" }));
    expect(JSON.parse(await readFile(path, "utf-8")).sessions).toHaveLength(1);
  });
});
