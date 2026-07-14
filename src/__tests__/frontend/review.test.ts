import { describe, it, expect } from "vitest";
import { generateReview } from "../../frontend/workspace/review.js";
import type { DiffResult } from "../../frontend/workspace/diff.js";
import type { LLMProvider } from "../../providers/llm-provider.js";

/** Provider fake: devuelve el texto dado como respuesta del LLM. */
function fakeProvider(text: string, onCall?: () => void): LLMProvider {
  return {
    call: async () => {
      onCall?.();
      return {
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
        cost: 0,
      };
    },
  } as unknown as LLMProvider;
}

const oneFileDiff: DiffResult = {
  base: null,
  files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, binary: false, patch: "@@ -1 +1 @@\n+x" }],
  totals: { files: 1, additions: 1, deletions: 0 },
};
const emptyDiff: DiffResult = { base: null, files: [], totals: { files: 0, additions: 0, deletions: 0 } };
const OPTS = { model: "m", maxTokens: 1000 };

describe("generateReview", () => {
  it("diff vacío → NO llama al LLM, steps vacíos", async () => {
    let called = false;
    const g = await generateReview(emptyDiff, fakeProvider("{}", () => { called = true; }), OPTS);
    expect(g.steps).toEqual([]);
    expect(called).toBe(false); // no gastamos una llamada por nada
  });

  it("parsea el JSON del LLM (con ```json fences)", async () => {
    const p = fakeProvider('```json\n{"steps":[{"title":"Paso 1","rationale":"por esto","files":["a.ts"]}]}\n```');
    const g = await generateReview(oneFileDiff, p, OPTS);
    expect(g.steps).toHaveLength(1);
    expect(g.steps[0]).toMatchObject({ title: "Paso 1", rationale: "por esto", files: ["a.ts"] });
  });

  it("tolera texto alrededor del JSON (queda con el objeto)", async () => {
    const p = fakeProvider('Acá va la guía:\n{"steps":[{"title":"X","rationale":"y","files":[]}]}\nlisto.');
    const g = await generateReview(oneFileDiff, p, OPTS);
    expect(g.steps[0].title).toBe("X");
  });

  it("coerce campos faltantes / mal tipados", async () => {
    const p = fakeProvider('{"steps":[{"title":"","files":"nope"}]}');
    const g = await generateReview(oneFileDiff, p, OPTS);
    expect(g.steps[0].title).toBe("(sin título)");
    expect(g.steps[0].rationale).toBe("");
    expect(g.steps[0].files).toEqual([]); // "nope" (no-array) → []
  });

  it("propaga el base del diff", async () => {
    const withBase: DiffResult = { ...oneFileDiff, base: "main" };
    const g = await generateReview(withBase, fakeProvider('{"steps":[]}'), OPTS);
    expect(g.base).toBe("main");
  });
});
