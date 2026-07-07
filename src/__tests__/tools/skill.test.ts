import { describe, it, expect } from "vitest";
import { SkillTool } from "../../tools/skill.js";
import { Skill } from "../../skills.js";

const SKILLS: Skill[] = [
  {
    name: "pdf-extract",
    description: "Extrae texto de PDFs",
    body: "Corré pdftotext sobre el archivo.",
    dir: "/repo/.omega/skills/pdf",
    source: "project",
  },
];

describe("SkillTool", () => {
  it("returns the full body of a known skill", async () => {
    const tool = new SkillTool(SKILLS);
    const out = await tool.execute({ name: "pdf-extract" });
    expect(out).toContain("Corré pdftotext");
    expect(out).toContain("pdf-extract");
    // Da el dir para leer archivos bundled.
    expect(out).toContain("/repo/.omega/skills/pdf");
  });

  it("is tolerant to a leading slash in the name", async () => {
    const tool = new SkillTool(SKILLS);
    const out = await tool.execute({ name: "/pdf-extract" });
    expect(out).toContain("Corré pdftotext");
  });

  it("lists available skills when the name is unknown", async () => {
    const tool = new SkillTool(SKILLS);
    const out = await tool.execute({ name: "nope" });
    expect(out).toContain("No existe");
    expect(out).toContain("pdf-extract");
  });

  it("handles having no skills installed", async () => {
    const tool = new SkillTool([]);
    const out = await tool.execute({ name: "whatever" });
    expect(out).toContain("No hay skills instaladas");
  });
});
