import { describe, it, expect } from "vitest";
import { foldDossier } from "../../dossier/fold.js";
import { Entry } from "../../dossier/types.js";

function makeEntry(overrides: Partial<Entry> & { id: string }): Entry {
  return {
    type: "observation",
    text: "Default entry text",
    ...overrides,
    id: overrides.id,
  };
}

describe("foldDossier", () => {
  it("devuelve texto vacío para dossier vacío", () => {
    const result = foldDossier(new Map());
    expect(result.text).toBe("");
    expect(result.includedIds.size).toBe(0);
  });

  it("serializa una entrada con el formato correcto", () => {
    const live = new Map<string, Entry>();
    live.set("d1", makeEntry({
      id: "d1",
      type: "decision",
      text: "Usar SQLite en vez de JSON",
      rationale: "Mejor performance y queries",
      refs: { path: "src/db.ts", line: 42 },
    }));

    const result = foldDossier(live, { maxTokens: 1000 });

    expect(result.text).toContain("[decision]");
    expect(result.text).toContain("Usar SQLite en vez de JSON");
    expect(result.text).toContain("Mejor performance y queries");
    expect(result.text).toContain("(refs: src/db.ts:42)");
    expect(result.includedIds.has("d1")).toBe(true);
  });

  it("aplana newlines a espacios en el texto", () => {
    const live = new Map<string, Entry>();
    live.set("g1", makeEntry({
      id: "g1",
      type: "gotcha",
      text: "Los tests\nnecesitan Docker\ncorriendo",
    }));

    const result = foldDossier(live, { maxTokens: 1000 });

    expect(result.text).toBe("[gotcha] Los tests necesitan Docker corriendo");
    expect(result.text).not.toContain("\n");
  });

  it("ordena por prioridad: decisions antes que observations", () => {
    const live = new Map<string, Entry>();
    live.set("o1", makeEntry({ id: "o1", type: "observation", text: "Observation" }));
    live.set("d1", makeEntry({ id: "d1", type: "decision", text: "Decision" }));

    const result = foldDossier(live, { maxTokens: 1000 });

    const decisionIdx = result.text.indexOf("Decision");
    const observationIdx = result.text.indexOf("Observation");
    expect(decisionIdx).toBeLessThan(observationIdx);
  });

  it("las open tasks aparecen antes que las done tasks", () => {
    const live = new Map<string, Entry>();
    live.set("t1", makeEntry({ id: "t1", type: "task", text: "Open task", state: "open" }));
    live.set("t2", makeEntry({ id: "t2", type: "task", text: "Done task", state: "done" }));

    const result = foldDossier(live, { maxTokens: 1000 });

    const openIdx = result.text.indexOf("Open task");
    const doneIdx = result.text.indexOf("Done task");
    expect(openIdx).toBeLessThan(doneIdx);
  });

  it("respeta el budget de tokens", () => {
    const live = new Map<string, Entry>();
    // Crear entries largas para forzar el corte
    for (let i = 0; i < 50; i++) {
      live.set(`e${i}`, makeEntry({
        id: `e${i}`,
        type: "observation",
        text: `Entry number ${i} with a reasonably long text that will consume budget tokens `.repeat(3),
      }));
    }

    // Budget muy chico: 200 tokens
    const result = foldDossier(live, { maxTokens: 200 });

    // Deberían entrar pocas entries
    expect(result.includedIds.size).toBeLessThan(10);
    // El texto no debería superar el budget en chars
    const maxChars = 200 * 4; // default charsPerToken
    expect(result.text.length).toBeLessThanOrEqual(maxChars + 10); // margen para newlines
  });

  it("incluye rationale en la línea serializada", () => {
    const live = new Map<string, Entry>();
    live.set("f1", makeEntry({
      id: "f1",
      type: "file",
      text: "Modifiqué auth.ts",
      rationale: "Para arreglar el bug de login",
      refs: { path: "src/auth.ts" },
    }));

    const result = foldDossier(live, { maxTokens: 1000 });

    expect(result.text).toContain("Modifiqué auth.ts — Para arreglar el bug de login");
  });

  it("no incluye 'refs:' si no hay path", () => {
    const live = new Map<string, Entry>();
    live.set("d1", makeEntry({
      id: "d1",
      type: "decision",
      text: "Decisión sin archivos",
      refs: { toolUseId: "tu-123" },
    }));

    const result = foldDossier(live, { maxTokens: 1000 });

    expect(result.text).not.toContain("(refs:");
  });

  it("el orden dentro del tipo prioriza IDs más altos (proxy de recencia)", () => {
    const live = new Map<string, Entry>();
    live.set("d-aaa", makeEntry({ id: "d-aaa", type: "decision", text: "Old" }));
    live.set("d-zzz", makeEntry({ id: "d-zzz", type: "decision", text: "New" }));

    const result = foldDossier(live, { maxTokens: 1000 });

    const newIdx = result.text.indexOf("New");
    const oldIdx = result.text.indexOf("Old");
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it("entries sin estado no compiten con tasks por orden", () => {
    const live = new Map<string, Entry>();
    live.set("t1", makeEntry({ id: "t1", type: "task", text: "Task sin estado" }));
    live.set("d1", makeEntry({ id: "d1", type: "decision", text: "Decisión" }));

    const result = foldDossier(live, { maxTokens: 1000 });

    // decisions antes que tasks
    const dIdx = result.text.indexOf("Decisión");
    const tIdx = result.text.indexOf("Task sin estado");
    expect(dIdx).toBeLessThan(tIdx);
  });
});
