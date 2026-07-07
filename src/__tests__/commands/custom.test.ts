import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadCustomCommands, expandCommand } from "../../commands/custom.js";

// ── expandCommand ────────────────────────────────────────────────────────────

describe("expandCommand", () => {
  const cmd = (body: string) => ({
    name: "/x",
    description: "d",
    body,
    source: "project" as const,
  });

  it("substitutes $ARGUMENTS with all args joined", () => {
    expect(expandCommand(cmd("deploy: $ARGUMENTS"), ["prod", "--force"])).toBe(
      "deploy: prod --force",
    );
  });

  it("substitutes positional $1..$9", () => {
    expect(expandCommand(cmd("$1 → $2"), ["from", "to"])).toBe("from → to");
  });

  it("uses empty string for missing positionals", () => {
    expect(expandCommand(cmd("[$1][$2]"), ["solo"])).toBe("[solo][]");
  });

  it("leaves body intact when there are no placeholders", () => {
    expect(expandCommand(cmd("corré los tests"), ["ignored"])).toBe("corré los tests");
  });

  it("does not touch non-placeholder $ signs (shell vars, letters)", () => {
    expect(expandCommand(cmd("echo $HOME de $1"), ["café"])).toBe("echo $HOME de café");
  });
});

// ── loadCustomCommands ───────────────────────────────────────────────────────

describe("loadCustomCommands", () => {
  let cwd: string;
  let home: string;

  const write = (root: string, name: string, content: string) => {
    const dir = join(root, ".omega", "commands");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content);
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "omega-cwd-"));
    home = mkdtempSync(join(tmpdir(), "omega-home-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("returns empty when no commands dir exists", () => {
    expect(loadCustomCommands(cwd, home)).toEqual({});
  });

  it("loads a project command with frontmatter", () => {
    write(
      cwd,
      "deploy.md",
      "---\ndescription: Deploya el proyecto\nargument-hint: <entorno>\n---\nDeployá a $1",
    );
    const map = loadCustomCommands(cwd, home);
    expect(map["/deploy"]).toMatchObject({
      name: "/deploy",
      description: "Deploya el proyecto",
      argumentHint: "<entorno>",
      body: "Deployá a $1",
      source: "project",
    });
  });

  it("loads a command with no frontmatter (default description)", () => {
    write(home, "note.md", "Anotá esto: $ARGUMENTS");
    const map = loadCustomCommands(cwd, home);
    expect(map["/note"].body).toBe("Anotá esto: $ARGUMENTS");
    expect(map["/note"].source).toBe("global");
    expect(map["/note"].description).toContain("global");
  });

  it("lets a project command override a global one of the same name", () => {
    write(home, "foo.md", "global body");
    write(cwd, "foo.md", "project body");
    const map = loadCustomCommands(cwd, home);
    expect(map["/foo"].source).toBe("project");
    expect(map["/foo"].body).toBe("project body");
  });

  it("ignores non-.md files", () => {
    write(cwd, "readme.txt", "not a command");
    write(cwd, "real.md", "soy real");
    const map = loadCustomCommands(cwd, home);
    expect(Object.keys(map)).toEqual(["/real"]);
  });
});
