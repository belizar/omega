import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, rmSync, mkdirSync } from "fs";
import { DossierJournal, buildLiveDossier } from "../../dossier/journal.js";
import { DossierEvent, Entry } from "../../dossier/types.js";

const TEST_DIR = ".omega/dossiers/test";
const TASK_ID = "test-task-1";

function makeCreateEvent(
  overrides: Partial<DossierEvent> & { entryId: string; snapshot: Entry },
): Omit<DossierEvent, "seq"> {
  return {
    ts: new Date().toISOString(),
    taskId: TASK_ID,
    sessionId: "session-1",
    actor: "agent",
    op: "create",
    ...overrides,
  };
}

describe("DossierJournal", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it("crea el archivo JSONL al primer append", () => {
    const journal = new DossierJournal(TEST_DIR, TASK_ID);

    const event = makeCreateEvent({
      entryId: "entry-1",
      snapshot: { id: "entry-1", type: "decision", text: "Test decision" },
    });

    const result = journal.append(event);

    expect(result.seq).toBe(0);
    expect(existsSync(journal.filePath)).toBe(true);
  });

  it("asigna seq incremental", () => {
    const journal = new DossierJournal(TEST_DIR, TASK_ID);

    const e1 = journal.append(makeCreateEvent({
      entryId: "entry-1",
      snapshot: { id: "entry-1", type: "decision", text: "First" },
    }));

    const e2 = journal.append(makeCreateEvent({
      entryId: "entry-2",
      snapshot: { id: "entry-2", type: "gotcha", text: "Second" },
    }));

    expect(e1.seq).toBe(0);
    expect(e2.seq).toBe(1);
  });

  it("readAll reconstruye todos los eventos", () => {
    const journal = new DossierJournal(TEST_DIR, TASK_ID);

    journal.append(makeCreateEvent({
      entryId: "entry-1",
      snapshot: { id: "entry-1", type: "decision", text: "A" },
    }));

    journal.append(makeCreateEvent({
      entryId: "entry-2",
      snapshot: { id: "entry-2", type: "task", text: "B", state: "open" },
    }));

    const all = journal.readAll();
    expect(all.length).toBe(2);
    expect(all[0].seq).toBe(0);
    expect(all[0].entryId).toBe("entry-1");
    expect(all[1].seq).toBe(1);
    expect(all[1].entryId).toBe("entry-2");
  });

  it("readAll devuelve array vacío si no hay archivo", () => {
    const journal = new DossierJournal(TEST_DIR, "nonexistent");
    expect(journal.readAll()).toEqual([]);
  });

  it("reanuda el seq desde archivo existente", () => {
    const journal1 = new DossierJournal(TEST_DIR, TASK_ID);
    journal1.append(makeCreateEvent({
      entryId: "entry-1",
      snapshot: { id: "entry-1", type: "decision", text: "A" },
    }));

    // Simulamos nueva instancia (como reiniciar el proceso)
    const journal2 = new DossierJournal(TEST_DIR, TASK_ID);
    const e2 = journal2.append(makeCreateEvent({
      entryId: "entry-2",
      snapshot: { id: "entry-2", type: "gotcha", text: "B" },
    }));

    expect(e2.seq).toBe(1); // sigue del anterior
    expect(journal2.readAll().length).toBe(2);
  });
});

describe("buildLiveDossier", () => {
  it("devuelve el último snapshot por entryId", () => {
    const events: DossierEvent[] = [
      {
        seq: 0, ts: "2025-01-01T00:00:00Z", taskId: "t1", sessionId: "s1",
        actor: "agent", op: "create", entryId: "e1",
        snapshot: { id: "e1", type: "task", text: "Old", state: "open" },
      },
      {
        seq: 1, ts: "2025-01-01T00:00:01Z", taskId: "t1", sessionId: "s1",
        actor: "agent", op: "update", entryId: "e1",
        delta: { text: "Old" },
        snapshot: { id: "e1", type: "task", text: "Updated", state: "open" },
      },
    ];

    const live = buildLiveDossier(events);
    expect(live.size).toBe(1);
    expect(live.get("e1")!.text).toBe("Updated");
  });

  it("excluye entries evictadas", () => {
    const events: DossierEvent[] = [
      {
        seq: 0, ts: "2025-01-01T00:00:00Z", taskId: "t1", sessionId: "s1",
        actor: "agent", op: "create", entryId: "e1",
        snapshot: { id: "e1", type: "observation", text: "Something" },
      },
      {
        seq: 1, ts: "2025-01-01T00:00:01Z", taskId: "t1", sessionId: "s1",
        actor: "system", op: "evict", entryId: "e1", mechanism: "ladder",
        snapshot: { id: "e1", type: "observation", text: "Something" },
      },
    ];

    const live = buildLiveDossier(events);
    expect(live.size).toBe(0);
  });

  it("maneja create + complete de tasks", () => {
    const events: DossierEvent[] = [
      {
        seq: 0, ts: "2025-01-01T00:00:00Z", taskId: "t1", sessionId: "s1",
        actor: "agent", op: "create", entryId: "t1",
        snapshot: { id: "t1", type: "task", text: "Do X", state: "open" },
      },
      {
        seq: 1, ts: "2025-01-01T00:00:01Z", taskId: "t1", sessionId: "s1",
        actor: "agent", op: "complete", entryId: "t1",
        snapshot: { id: "t1", type: "task", text: "Do X", state: "done" },
      },
    ];

    const live = buildLiveDossier(events);
    expect(live.get("t1")!.state).toBe("done");
  });

  it("ignora eventos sin entryId (lifecycle)", () => {
    const events: DossierEvent[] = [
      {
        seq: 0, ts: "2025-01-01T00:00:00Z", taskId: "t1", sessionId: "s1",
        actor: "system", op: "task_start",
      },
      {
        seq: 1, ts: "2025-01-01T00:00:01Z", taskId: "t1", sessionId: "s1",
        actor: "system", op: "session_end",
      },
    ];

    const live = buildLiveDossier(events);
    expect(live.size).toBe(0);
  });

  it("las entries comprimidas mantienen el snapshot actualizado", () => {
    const events: DossierEvent[] = [
      {
        seq: 0, ts: "2025-01-01T00:00:00Z", taskId: "t1", sessionId: "s1",
        actor: "agent", op: "create", entryId: "f1",
        snapshot: { id: "f1", type: "file", text: "Edited X", refs: { path: "src/x.ts", line: 10 } },
      },
      {
        seq: 1, ts: "2025-01-01T00:00:01Z", taskId: "t1", sessionId: "s1",
        actor: "system", op: "compress", entryId: "f1", mechanism: "ladder",
        snapshot: { id: "f1", type: "file", text: "Edited X", refs: {} },
      },
    ];

    const live = buildLiveDossier(events);
    expect(live.get("f1")!.refs!.path).toBeUndefined();
  });
});
