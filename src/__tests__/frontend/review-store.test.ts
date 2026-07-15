import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fingerprintDiff, assembleReview, saveReview, listReviews } from "../../frontend/workspace/review-store.js";
import type { DiffResult } from "../../frontend/workspace/diff.js";
import type { ReviewContent } from "../../frontend/workspace/review.js";

function diff(files: DiffResult["files"], base: string | null = null): DiffResult {
  return { base, files, totals: { files: files.length, additions: 0, deletions: 0 } };
}
const fileA = { path: "a.ts", status: "modified" as const, additions: 1, deletions: 0, binary: false, patch: "@@ +x" };
const fileB = { path: "b.ts", status: "modified" as const, additions: 2, deletions: 0, binary: false, patch: "@@ +y" };
const content: ReviewContent = { steps: [{ title: "P1", rationale: "por esto", files: ["a.ts"] }], diagrams: [] };

describe("fingerprintDiff", () => {
  it("es estable para el mismo contenido", () => {
    expect(fingerprintDiff(diff([fileA]))).toBe(fingerprintDiff(diff([fileA])));
  });
  it("no depende del orden de los archivos", () => {
    expect(fingerprintDiff(diff([fileA, fileB]))).toBe(fingerprintDiff(diff([fileB, fileA])));
  });
  it("cambia si cambia el contenido o la base", () => {
    expect(fingerprintDiff(diff([fileA]))).not.toBe(fingerprintDiff(diff([fileB])));
    expect(fingerprintDiff(diff([fileA], "main"))).not.toBe(fingerprintDiff(diff([fileA], null)));
  });
});

describe("save/listReviews", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omega-reviews-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const mk = (fp: string, lens: string, createdAt: number) =>
    assembleReview(content, { base: null, headSha: "abc123", fingerprint: fp, lens, createdAt });

  it("roundtrip: guarda y lista", () => {
    saveReview(dir, mk("fp1", "", 100));
    const got = listReviews(dir);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ fingerprint: "fp1", lens: "", headSha: "abc123", steps: content.steps });
  });

  it("ordena las más nuevas primero", () => {
    saveReview(dir, mk("fp1", "", 100));
    saveReview(dir, mk("fp2", "", 300));
    saveReview(dir, mk("fp3", "", 200));
    expect(listReviews(dir).map((r) => r.fingerprint)).toEqual(["fp2", "fp3", "fp1"]);
  });

  it("mismo (fingerprint, lente) sobrescribe — no duplica", () => {
    saveReview(dir, mk("fp1", "", 100));
    saveReview(dir, mk("fp1", "", 999)); // regenerada
    const got = listReviews(dir);
    expect(got).toHaveLength(1);
    expect(got[0].createdAt).toBe(999);
  });

  it("distinta lente sobre el mismo diff → reviews separadas", () => {
    saveReview(dir, mk("fp1", "", 100));
    saveReview(dir, mk("fp1", "desde DDD", 200));
    expect(listReviews(dir)).toHaveLength(2);
  });

  it("dir inexistente → lista vacía", () => {
    expect(listReviews(join(dir, "nope"))).toEqual([]);
  });
});
