import { describe, it, expect } from "vitest";
import { generateReview } from "../../frontend/workspace/review.js";
import type { DiffResult } from "../../frontend/workspace/diff.js";
import type { LLMProvider } from "../../providers/llm-provider.js";

/** Provider fake: devuelve el texto dado; onCall recibe el AgentConfig (para
 *  inspeccionar el system prompt que armó generateReview). */
function fakeProvider(text: string, onCall?: (agent: { systemPrompt?: string }) => void): LLMProvider {
  return {
    call: async (_messages: unknown, agent: { systemPrompt?: string }) => {
      onCall?.(agent);
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

  it("sin diagrams en el JSON → diagrams:[]", async () => {
    const g = await generateReview(oneFileDiff, fakeProvider('{"steps":[{"title":"X","rationale":"y","files":[]}]}'), OPTS);
    expect(g.diagrams).toEqual([]);
  });

  it("parsea los diagramas (kind válido + descarta los sin mermaid)", async () => {
    const p = fakeProvider('{"steps":[],"diagrams":[{"title":"Flujo","kind":"sequence","mermaid":"sequenceDiagram\\n A->>B: x"},{"title":"vacío","kind":"class","mermaid":""}]}');
    const g = await generateReview(oneFileDiff, p, OPTS);
    expect(g.diagrams).toHaveLength(1); // el vacío se descarta
    expect(g.diagrams[0]).toMatchObject({ title: "Flujo", kind: "sequence" });
    expect(g.diagrams[0].mermaid).toContain("sequenceDiagram");
  });

  it("kind desconocido → cae a 'sequence'", async () => {
    const p = fakeProvider('{"steps":[],"diagrams":[{"title":"D","kind":"pizza","mermaid":"graph TD; A-->B"}]}');
    const g = await generateReview(oneFileDiff, p, OPTS);
    expect(g.diagrams[0].kind).toBe("sequence");
  });

  it("la lente se inyecta en el system prompt", async () => {
    let sys = "";
    const p = fakeProvider('{"steps":[]}', (agent) => { sys = agent.systemPrompt ?? ""; });
    await generateReview(oneFileDiff, p, { ...OPTS, lens: "desde el punto de vista DDD" });
    expect(sys).toContain("ENFOQUE");
    expect(sys).toContain("desde el punto de vista DDD");
  });

  it("diagrams:true agrega la instrucción de diagramas al prompt; false no", async () => {
    let withD = "", without = "";
    await generateReview(oneFileDiff, fakeProvider('{"steps":[]}', (a) => { withD = a.systemPrompt ?? ""; }), { ...OPTS, diagrams: true });
    await generateReview(oneFileDiff, fakeProvider('{"steps":[]}', (a) => { without = a.systemPrompt ?? ""; }), { ...OPTS, diagrams: false });
    expect(withD).toContain("DIAGRAMAS");
    expect(withD).toContain("diagrams");
    expect(without).not.toContain("DIAGRAMAS");
  });
});
