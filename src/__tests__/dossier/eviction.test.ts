import { describe, it, expect } from "vitest";
import { evictDossier } from "../../dossier/eviction.js";
import { Entry, DossierEvent } from "../../dossier/types.js";

function makeEntry(overrides: Partial<Entry> & { id: string }): Entry {
  return {
    type: "observation",
    text: "Default entry text",
    ...overrides,
    id: overrides.id,
  };
}

function baseEvent(): Pick<DossierEvent, "ts" | "taskId" | "sessionId" | "actor"> {
  return {
    ts: new Date().toISOString(),
    taskId: "task-1",
    sessionId: "session-1",
    actor: "system",
  };
}

// Helpers para entradas con tamaño controlado.
// Con charsPerToken=4, necesito 4 chars por token.
// Una entry con text de N chars = ceil(N/4) tokens.

/** Crea una entry de N tokens (approx). text = "X".repeat(nTokens * 4). */
function entryOf(nTokens: number, overrides: Partial<Entry> & { id: string }): Entry {
  return makeEntry({
    text: "X".repeat(Math.max(1, nTokens * 4)),
    ...overrides,
    id: overrides.id,
  });
}

describe("evictDossier", () => {
  it("no evicta si todo entra en el budget", () => {
    const live = new Map<string, Entry>();
    live.set("d1", makeEntry({ id: "d1", type: "decision", text: "Short" }));

    const result = evictDossier(live, baseEvent(), { maxTokens: 1000 });

    expect(result.evicted).toBe(0);
    expect(result.compressed).toBe(0);
    expect(result.live.size).toBe(1);
    expect(result.events.length).toBe(0);
  });

  it("no evicta si el tier alto no llega al umbral mínimo", () => {
    const live = new Map<string, Entry>();
    for (let i = 0; i < 20; i++) {
      live.set(`o${i}`, entryOf(12, { id: `o${i}`, type: "observation" }));
    }

    // Total tokens: 20 * 12 = 240. Budget: 50 => hay overflow.
    // Pero highTierMinTokens=500 y el tier alto es 0 => no evicta.
    const result = evictDossier(live, baseEvent(), {
      maxTokens: 50,
      highTierMinTokens: 500,
    });

    expect(result.evicted).toBe(0);
    expect(result.live.size).toBe(20);
  });

  it("evicta done/dropped tasks primero", () => {
    const live = new Map<string, Entry>();
    // Done task: 500 tokens  +  Open task: 130 tokens = 630 total.
    // Budget: 200. Tier alto (open task): 130 > highTierMinTokens (10)
    // => se dispara evicción. Done task se va primero.
    live.set("dt1", entryOf(500, { id: "dt1", type: "task", state: "done" }));
    live.set("ot1", entryOf(130, { id: "ot1", type: "task", state: "open" }));

    const result = evictDossier(live, baseEvent(), {
      maxTokens: 200,
      highTierMinTokens: 10,
    });

    expect(result.live.has("dt1")).toBe(false);
    expect(result.live.has("ot1")).toBe(true);
    expect(result.evicted).toBeGreaterThanOrEqual(1);
  });

  it("evicta observations después de done tasks", () => {
    const live = new Map<string, Entry>();
    live.set("dt1", entryOf(100, { id: "dt1", type: "task", state: "done" }));
    live.set("o1", entryOf(100, { id: "o1", type: "observation" }));
    // Open task con 26 tokens supera highTierMinTokens (10)
    live.set("ot1", entryOf(26, { id: "ot1", type: "task", state: "open" }));

    // Total: 100+100+26=226. Budget: 50.
    // Tier alto: 26 > 10 => evicción disparada.
    // Paso 1: evicta dt1 (100). Quedan 126 tokens.
    // Paso 2: evicta o1 (100). Quedan 26 tokens => budget 50: OK.
    const result = evictDossier(live, baseEvent(), {
      maxTokens: 50,
      highTierMinTokens: 10,
    });

    expect(result.live.has("dt1")).toBe(false);
    expect(result.live.has("o1")).toBe(false);
    expect(result.live.has("ot1")).toBe(true);
  });

  it("comprime files cuando el budget obliga tras evictar done tasks", () => {
    const live = new Map<string, Entry>();
    // Done tasks
    live.set("dt1", entryOf(200, { id: "dt1", type: "task", state: "done" }));
    live.set("dt2", entryOf(200, { id: "dt2", type: "task", state: "done" }));
    // File con path (comprimible): 20 tokens
    live.set("f1", makeEntry({
      id: "f1",
      type: "file",
      text: "X".repeat(40),
      rationale: "Y".repeat(40),
      refs: { path: "src/auth.ts", line: 42 },
    }));
    // Open task para pasar umbral: 30 tokens
    live.set("ot1", entryOf(30, { id: "ot1", type: "task", state: "open" }));

    // Total: 200+200+20+30 = 450. Budget: 60.
    // Tier alto: 30 > 10 => evicción.
    // Paso 1: evicta dt1+dt2 (400). Quedan 50 tokens.
    // 50 <= 60 => OK, no comprime. Usemos budget más chico.
    const result = evictDossier(live, baseEvent(), {
      maxTokens: 45,
      highTierMinTokens: 10,
    });

    // Con budget 45, tras evictar dt1+dt2 quedan 50 > 45.
    // Paso 2: no hay observations.
    // Paso 3: comprime f1 (20->10 tokens). 50-10=40 <= 45.
    expect(result.compressed).toBeGreaterThanOrEqual(1);
    expect(result.live.has("f1")).toBe(true);
    const f1 = result.live.get("f1")!;
    expect(f1.refs?.path).toBeUndefined();
  });

  it("evicta files ya comprimidas si sigue necesitando espacio", () => {
    const live = new Map<string, Entry>();
    live.set("dt1", entryOf(200, { id: "dt1", type: "task", state: "done" }));
    // File ya comprimida (sin path): 10 tokens
    live.set("f1", makeEntry({ id: "f1", type: "file", text: "X".repeat(40) }));
    // Open task para pasar umbral: 40 tokens
    live.set("ot1", entryOf(40, { id: "ot1", type: "task", state: "open" }));

    // Total: 200+10+40 = 250. Budget: 45.
    // Tier alto: 40 > 10 => evicción.
    // Paso 1: evicta dt1 (200). Quedan 50 tokens.
    // 50 > 45 budget => paso 2: no hay observations.
    // Paso 3: comprimir files. f1 ya está comprimida (sin path) => evict.
    const result = evictDossier(live, baseEvent(), {
      maxTokens: 45,
      highTierMinTokens: 10,
    });

    expect(result.live.has("f1")).toBe(false);
    expect(result.live.has("ot1")).toBe(true);
  });

  it("evicta open tasks y decisions en tier alto como último recurso", () => {
    const live = new Map<string, Entry>();
    // Llenar con muchas entries de tier alto (open tasks)
    for (let i = 0; i < 20; i++) {
      live.set(`t${i}`, entryOf(30, {
        id: `t${i}`,
        type: "task",
        state: "open",
      }));
    }

    // Total: 20 * 30 = 600 tokens. Budget: 100.
    // Tier alto: 600 > highTierMinTokens (10) => evicción.
    // needHighTierEviction = true (tier alto 600 > budget 100).
    // Paso 1-3: no hay done tasks, observations, files.
    // Paso 4: evicta open tasks.
    const result = evictDossier(live, baseEvent(), {
      maxTokens: 100,
      highTierMinTokens: 10,
    });

    expect(result.evicted).toBeGreaterThan(0);
    expect(result.live.size).toBeLessThan(20);
  });

  it("genera eventos con mechanism: ladder", () => {
    const live = new Map<string, Entry>();
    live.set("dt1", entryOf(200, { id: "dt1", type: "task", state: "done" }));
    live.set("ot1", entryOf(30, { id: "ot1", type: "task", state: "open" }));

    // Total: 230. Budget: 50. Tier alto: 30 > 10 => evicción.
    const result = evictDossier(live, baseEvent(), {
      maxTokens: 50,
      highTierMinTokens: 10,
    });

    expect(result.evicted).toBeGreaterThanOrEqual(1);
    for (const event of result.events) {
      expect(event.mechanism).toBe("ladder");
      expect(event.actor).toBe("system");
    }
  });

  it("evicta por orden de antigüedad dentro del mismo tipo", () => {
    const live = new Map<string, Entry>();
    // Varias observations con IDs que indican antigüedad
    live.set("obs-001", entryOf(100, { id: "obs-001", type: "observation" }));
    live.set("obs-002", entryOf(100, { id: "obs-002", type: "observation" }));
    live.set("obs-003", entryOf(100, { id: "obs-003", type: "observation" }));
    // Open task para pasar umbral
    live.set("ot1", entryOf(30, { id: "ot1", type: "task", state: "open" }));

    // Total: 330. Budget: 140. Tier alto: 30 > 10 => evicción.
    // Paso 1: no hay done tasks.
    // Paso 2: evicta observations. Necesita liberar 330-140=190 tokens.
    // Cada obs son 100 tokens. Evicta 2: obs-001 y obs-002.
    // Quedan 130 tokens <= 140 budget => OK.
    const result = evictDossier(live, baseEvent(), {
      maxTokens: 140,
      highTierMinTokens: 10,
    });

    // obs-001 (más antigua por ID) debería ser evictada primero
    expect(result.live.has("obs-001")).toBe(false);
    expect(result.live.has("obs-002")).toBe(false);
    // obs-003 (más nueva) sobrevive
    expect(result.live.has("obs-003")).toBe(true);
  });

  it("devuelve eventos para appendear al journal", () => {
    const live = new Map<string, Entry>();
    live.set("dt1", entryOf(200, { id: "dt1", type: "task", state: "done" }));
    live.set("ot1", entryOf(30, { id: "ot1", type: "task", state: "open" }));

    const result = evictDossier(live, baseEvent(), {
      maxTokens: 50,
      highTierMinTokens: 10,
    });

    // Debe haber al menos un evento de evict
    expect(result.evicted).toBeGreaterThanOrEqual(1);
    const evictEvents = result.events.filter((e) => e.op === "evict");
    expect(evictEvents.length).toBeGreaterThanOrEqual(1);
    expect(evictEvents[0].entryId).toBeDefined();
    expect(evictEvents[0].op).toBe("evict");
  });
});
