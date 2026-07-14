import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { computeDiff } from "../../frontend/diff.js";

const execFileAsync = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileAsync("git", args, { cwd });

async function initRepo(dir: string): Promise<void> {
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "t@t.t"]);
  await git(dir, ["config", "user.name", "t"]);
}

describe("computeDiff", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "omega-diff-"));
    await initRepo(dir);
    await writeFile(join(dir, "a.txt"), "uno\ndos\ntres\n", "utf-8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("sin base: captura modificaciones (working tree vs HEAD) con conteos y parche", async () => {
    await writeFile(join(dir, "a.txt"), "uno\nDOS\ntres\ncuatro\n", "utf-8"); // 1 mod + 1 add

    const d = await computeDiff(dir);
    expect(d.base).toBeNull();
    const a = d.files.find((f) => f.path === "a.txt");
    expect(a).toBeTruthy();
    expect(a!.status).toBe("modified");
    expect(a!.additions).toBe(2); // DOS + cuatro
    expect(a!.deletions).toBe(1); // dos
    expect(a!.patch).toContain("+cuatro");
    expect(a!.patch).toContain("-dos");
  });

  it("sin base: incluye archivos nuevos (untracked) como added", async () => {
    await writeFile(join(dir, "nuevo.ts"), "export const x = 1;\n", "utf-8");
    const d = await computeDiff(dir);
    const n = d.files.find((f) => f.path === "nuevo.ts");
    expect(n).toBeTruthy();
    expect(n!.status).toBe("added");
    expect(n!.additions).toBe(1);
    expect(n!.patch).toContain("+export const x = 1;");
  });

  it("con base: los cambios de una branch/PR (base...HEAD), no lo sin-commitear", async () => {
    await git(dir, ["checkout", "-q", "-b", "feat/x"]);
    await writeFile(join(dir, "b.txt"), "feature\n", "utf-8");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "add b"]);
    // Un cambio sin commitear que NO debe aparecer en el diff de la PR.
    await writeFile(join(dir, "a.txt"), "sucio\n", "utf-8");

    const d = await computeDiff(dir, "main");
    expect(d.base).toBe("main");
    expect(d.files.map((f) => f.path)).toContain("b.txt");
    expect(d.files.map((f) => f.path)).not.toContain("a.txt"); // el working-dirty queda afuera
    expect(d.totals.files).toBe(1);
  });

  it("detecta deletes y renames", async () => {
    await git(dir, ["rm", "-q", "a.txt"]);
    await writeFile(join(dir, "c.txt"), "solo\n", "utf-8");
    const d = await computeDiff(dir);
    expect(d.files.find((f) => f.path === "a.txt")!.status).toBe("deleted");
  });

  it("excluye .omega/ (estado propio de omega, no código del agente)", async () => {
    const { mkdir } = await import("fs/promises");
    await mkdir(join(dir, ".omega", "sessions"), { recursive: true });
    await writeFile(join(dir, ".omega", "sessions", "s.json"), "x".repeat(500) + "\n", "utf-8");
    await writeFile(join(dir, ".omega", "mcp.json"), "{}\n", "utf-8");
    await writeFile(join(dir, "real.ts"), "export const y = 2;\n", "utf-8"); // cambio real

    const d = await computeDiff(dir);
    const paths = d.files.map((f) => f.path);
    expect(paths).toContain("real.ts");
    expect(paths.some((p) => p.startsWith(".omega/"))).toBe(false); // omega no se ve
  });

  it("repo sin cambios → lista vacía, totales en cero", async () => {
    const d = await computeDiff(dir);
    expect(d.files).toHaveLength(0);
    expect(d.totals).toEqual({ files: 0, additions: 0, deletions: 0 });
  });
});
