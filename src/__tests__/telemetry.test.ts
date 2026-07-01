import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  record,
  listProjects,
  getProject,
  getGlobalSummary,
  inferProjectSlug,
  deleteProject,
} from "../telemetry.js";
import type { TelemetryRecord } from "../telemetry.js";

const HM = homedir();

// ── Tests ────────────────────────────────────────────────────────────────────

describe("inferProjectSlug", () => {
  it("should detect .git parent as project root", () => {
    const cwd = join(HM, "Workspace", "omega", "src");
    const result = inferProjectSlug(cwd);
    expect(result.slug).toBe("omega");
    expect(result.root).toContain("omega");
  });

  it("should use basename when no .git found", () => {
    const cwd = "/tmp/some-random-folder/sub";
    const result = inferProjectSlug(cwd);
    expect(result.slug).toBe("sub");
  });

  it("should handle root directory", () => {
    const result = inferProjectSlug("/");
    expect(result.slug).toBe("");
  });
});

describe("TelemetryStore integration", () => {
  const TMP = join(HM, ".omega-test-tmp");
  const PROJ_A = join(TMP, "project-a");
  const PROJ_B = join(TMP, "project-b");

  const records: TelemetryRecord[] = [
    {
      id: "int-1", name: "A-1", savedAt: "2025-06-01T10:00:00Z",
      totalCost: 0.05, totalTokens: { input: 5000, output: 2000 },
      model: "gpt-4o", cwd: join(PROJ_A, "src"),
    },
    {
      id: "int-2", name: "A-2", savedAt: "2025-06-02T10:00:00Z",
      totalCost: 0.03, totalTokens: { input: 3000, output: 1000 },
      model: "gpt-4o", cwd: PROJ_A,
    },
    {
      id: "int-3", name: "B-1", savedAt: "2025-06-03T10:00:00Z",
      totalCost: 0.10, totalTokens: { input: 10000, output: 5000 },
      model: "claude", cwd: PROJ_B,
    },
  ];

  beforeAll(() => {
    mkdirSync(join(PROJ_A, ".git"), { recursive: true });
    mkdirSync(join(PROJ_B, ".git"), { recursive: true });
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const slug of ["project-a", "project-b"]) {
      const dir = join(HM, ".omega", "telemetry", slug);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("should record and retrieve a project", () => {
    for (const r of records) record(r);

    const a = getProject("project-a");
    expect(a).not.toBeNull();
    expect(a!.sessionCount).toBe(2);
    expect(a!.totalCost).toBeCloseTo(0.08, 3);
    expect(a!.totalTokens.input).toBe(8000);
    expect(a!.totalTokens.output).toBe(3000);

    const b = getProject("project-b");
    expect(b).not.toBeNull();
    expect(b!.sessionCount).toBe(1);
    expect(b!.totalCost).toBeCloseTo(0.10, 2);
  });

  it("should list all projects sorted by cost", () => {
    for (const r of records) record(r);

    const projects = listProjects();
    const names = projects.map(p => p.project);
    expect(names).toContain("project-a");
    expect(names).toContain("project-b");
    expect(names.indexOf("project-b")).toBeLessThan(names.indexOf("project-a"));
  });

  it("should handle empty telemetry gracefully", () => {
    const summary = getGlobalSummary();
    expect(summary).toBeDefined();
    expect(typeof summary.totalCost).toBe("number");
    expect(Array.isArray(summary.projects)).toBe(true);
  });

  it("should merge existing records on re-record", () => {
    record(records[0]);
    record({ ...records[0], totalCost: 0.08, totalTokens: { input: 7000, output: 3000 } });

    const project = getProject("project-a");
    expect(project).not.toBeNull();
    const s = project!.sessions.find(s => s.id === "int-1");
    expect(s).toBeDefined();
    expect(s!.totalCost).toBe(0.08);
    expect(s!.totalTokens.input).toBe(7000);
  });

  it("should delete a project", () => {
    record(records[2]);
    expect(deleteProject("project-b")).toBe(true);
    expect(getProject("project-b")).toBeNull();
  });
});