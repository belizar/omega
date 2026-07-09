import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadSkills } from "../skills.js";
import { loadSkillsContext } from "../system-prompt.js";

describe("loadSkills", () => {
  let cwd: string;
  let home: string;

  const writeSkill = (root: string, name: string, content: string) => {
    const dir = join(root, ".omega", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content);
    return dir;
  };

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "omega-cwd-"));
    home = mkdtempSync(join(tmpdir(), "omega-home-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("returns empty when no skills dir exists", () => {
    expect(loadSkills(cwd, home)).toEqual([]);
  });

  it("loads a project skill with frontmatter", () => {
    const dir = writeSkill(
      cwd,
      "pdf",
      "---\nname: pdf-extract\ndescription: Extrae texto de PDFs\n---\nUsá pdftotext...",
    );
    const skills = loadSkills(cwd, home);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "pdf-extract",
      description: "Extrae texto de PDFs",
      body: "Usá pdftotext...",
      dir,
      source: "project",
    });
  });

  it("defaults the name to the dir when frontmatter has none", () => {
    writeSkill(home, "changelog", "---\ndescription: Arma el changelog\n---\nPasos...");
    const skills = loadSkills(cwd, home);
    expect(skills[0].name).toBe("changelog");
    expect(skills[0].source).toBe("global");
  });

  it("lets a project skill override a global one of the same name", () => {
    writeSkill(home, "deploy", "---\nname: deploy\ndescription: global\n---\nglobal body");
    writeSkill(cwd, "deploy", "---\nname: deploy\ndescription: project\n---\nproject body");
    const skills = loadSkills(cwd, home);
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("project");
    expect(skills[0].body).toBe("project body");
  });

  it("ignores dirs without a SKILL.md and stray files", () => {
    mkdirSync(join(cwd, ".omega", "skills", "empty-dir"), { recursive: true });
    writeFileSync(join(cwd, ".omega", "skills", "loose.txt"), "no soy skill");
    writeSkill(cwd, "real", "---\ndescription: real\n---\nb");
    const skills = loadSkills(cwd, home);
    expect(skills.map((s) => s.name)).toEqual(["real"]);
  });

  it("sorts skills by name", () => {
    writeSkill(cwd, "zeta", "---\ndescription: z\n---\nb");
    writeSkill(cwd, "alpha", "---\ndescription: a\n---\nb");
    expect(loadSkills(cwd, home).map((s) => s.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("loadSkillsContext", () => {
  it("returns empty string when there are no skills", () => {
    expect(loadSkillsContext([])).toBe("");
  });

  it("lists name and description but not the body (progressive disclosure)", () => {
    const ctx = loadSkillsContext([
      { name: "pdf", description: "Extrae PDFs", body: "SECRETO PESADO", dir: "/x", source: "project" },
    ]);
    expect(ctx).toContain("Skills disponibles");
    expect(ctx).toContain("pdf");
    expect(ctx).toContain("Extrae PDFs");
    expect(ctx).toContain("`skill`"); // menciona la tool para cargarlas
    expect(ctx).not.toContain("SECRETO PESADO"); // el body NO entra al prompt
  });
});
