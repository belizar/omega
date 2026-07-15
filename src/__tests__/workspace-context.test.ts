import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorkspaceContext } from "../workspace-context.js";

describe("WorkspaceContext", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omega-wsctx-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function writeMcp(root: string, serverName: string) {
    mkdirSync(join(root, ".omega"), { recursive: true });
    writeFileSync(join(root, ".omega", "mcp.json"), JSON.stringify({ servers: { [serverName]: { command: "echo", args: [] } } }));
  }

  it("resuelve el MCP del .omega del cwd que se le pasa (no de process.cwd)", () => {
    writeMcp(dir, "wsctxsrv");
    const ctx = new WorkspaceContext(dir);
    expect(Object.keys(ctx.loadMcp() ?? {})).toContain("wsctxsrv");
  });

  it("projectRoot = git-root cuando el cwd está en un repo", () => {
    execSync("git init -q", { cwd: dir });
    // .omega en el root del repo; el ctx opera desde un SUBDIR
    writeMcp(dir, "rootsrv");
    const sub = join(dir, "packages", "x");
    mkdirSync(sub, { recursive: true });
    const ctx = new WorkspaceContext(sub);
    // aunque el cwd sea el subdir, el .omega se resuelve en el root del repo
    expect(Object.keys(ctx.loadMcp() ?? {})).toContain("rootsrv");
  });

  it("sin repo → projectRoot = cwd", () => {
    const ctx = new WorkspaceContext(dir);
    expect(ctx.projectRoot).toBe(dir);
  });
});
