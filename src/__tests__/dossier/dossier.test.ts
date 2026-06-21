import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "fs";
import { Dossier } from "../../dossier/dossier.js";
import type { Note, Entry } from "../../dossier/types.js";

const TEST_DIR = ".omega/dossiers/test-dossier";
const TASK_ID = "test-dossier-1";

describe("Dossier", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("processNotes", () => {
    it("genera eventos create para cada note", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      const notes: Note[] = [
        { type: "decision", text: "Elegir SQLite" },
        { type: "gotcha", text: "Tests necesitan Docker" },
      ];

      const events = dossier.processNotes(notes, "tool-1");

      expect(events.length).toBe(2);
      expect(events[0].op).toBe("create");
      expect(events[0].entryId).toBeDefined();
      expect(events[0].snapshot!.type).toBe("decision");
      expect(events[1].snapshot!.type).toBe("gotcha");
    });

    it("asigna refs.toolUseId a las entries creadas", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      const notes: Note[] = [{ type: "observation", text: "Algo" }];
      const events = dossier.processNotes(notes, "tool-abc-123");

      expect(events[0].snapshot!.refs?.toolUseId).toBe("tool-abc-123");
    });

    it("crea task con state: open para notes de tipo task", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      const notes: Note[] = [{ type: "task", text: "Hacer X" }];
      const events = dossier.processNotes(notes, "tool-1");

      const entry = events[0].snapshot!;
      expect(entry.type).toBe("task");
      expect(entry.state).toBe("open");
    });

    it("soporta el patrón de dos notas (followUp)", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      const notes: Note[] = [
        {
          type: "decision",
          text: "Usar Postgres en vez de SQLite",
          followUp: "Migrar las queries existentes a pg",
        },
      ];

      const events = dossier.processNotes(notes, "tool-1");

      expect(events.length).toBe(2); // decisión + task
      expect(events[0].snapshot!.type).toBe("decision");
      expect(events[1].snapshot!.type).toBe("task");
      expect(events[1].snapshot!.state).toBe("open");
      expect(events[1].snapshot!.text).toBe("Migrar las queries existentes a pg");

      // Deben compartir threadId
      expect(events[0].snapshot!.threadId).toBeDefined();
      expect(events[0].snapshot!.threadId).toBe(events[1].snapshot!.threadId);
    });

    it("ignora followUp vacío", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      const notes: Note[] = [
        { type: "decision", text: "Algo", followUp: "" },
      ];

      const events = dossier.processNotes(notes, "tool-1");
      expect(events.length).toBe(1);
    });
  });

  describe("recordFileTouch", () => {
    it("crea una entry de tipo file con rationale y path", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      const event = dossier.recordFileTouch(
        "Arreglé el bug de login agregando await",
        "tool-edit-1",
        "src/auth.ts",
        42,
      );

      expect(event.op).toBe("create");
      expect(event.snapshot!.type).toBe("file");
      expect(event.snapshot!.text).toBe("Arreglé el bug de login agregando await");
      expect(event.snapshot!.refs?.path).toBe("src/auth.ts");
      expect(event.snapshot!.refs?.line).toBe(42);
      expect(event.snapshot!.refs?.toolUseId).toBe("tool-edit-1");
    });
  });

  describe("completeTask", () => {
    it("actualiza el estado de una task a done", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      // Crear task primero
      const notes: Note[] = [{ type: "task", text: "Hacer tests" }];
      const [createEvent] = dossier.processNotes(notes, "tool-1");
      const taskId = createEvent.entryId!;

      // Completarla
      const event = dossier.completeTask(taskId, "done");

      expect(event.op).toBe("complete");
      expect(event.snapshot!.state).toBe("done");

      // Verificar que el dossier vivo refleja el cambio
      const live = dossier.live;
      expect(live.get(taskId)!.state).toBe("done");
    });

    it("soporta dropped como estado final", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      const notes: Note[] = [{ type: "task", text: "Idea loca" }];
      const [createEvent] = dossier.processNotes(notes, "tool-1");

      const event = dossier.completeTask(createEvent.entryId!, "dropped");
      expect(event.op).toBe("drop");
      expect(event.snapshot!.state).toBe("dropped");
    });
  });

  describe("supersede", () => {
    it("marca una entry como superseded", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      const event = dossier.supersede("old-decision-1", "new-decision-2");
      expect(event.op).toBe("supersede");
      expect(event.entryId).toBe("old-decision-1");
    });
  });

  describe("promote", () => {
    it("marca una entry para promoción a long-term", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      const event = dossier.promote("gotcha-1");
      expect(event.op).toBe("promote");
      expect(event.entryId).toBe("gotcha-1");
    });
  });

  describe("fold", () => {
    it("devuelve las entries en formato fold", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      dossier.processNotes([
        { type: "decision", text: "Usar X" },
        { type: "gotcha", text: "Cuidado con Y" },
      ], "tool-1");

      const { text, includedIds } = dossier.fold();

      expect(text).toContain("[decision]");
      expect(text).toContain("[gotcha]");
      expect(includedIds.size).toBe(2);
    });
  });

  describe("evict", () => {
    it("corre la escalera de evicción y appendea eventos", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

// Crear una done task grande y una open task para pasar highTierMinTokens
      dossier.processNotes([
        { type: "task", text: "O".repeat(500) },
      ], "tool-1");

      // Obtener la task y marcarla como done
      const taskId = [...dossier.live.values()].find((e: Entry) => e.type === "task")!.id;
      dossier.completeTask(taskId, "done");

      // Agregar una open task para que tier alto pase el umbral
      dossier.processNotes([
        { type: "task", text: "Small open task" },
      ], "tool-3");

      // También metemos observations
      dossier.processNotes([
        { type: "observation", text: "X".repeat(200) },
        { type: "observation", text: "X".repeat(200) },
      ], "tool-2");

      const eventsBefore = dossier.events.length;

      const result = dossier.evict({
        maxTokens: 30,
        highTierMinTokens: 3,
      });

      const eventsAfter = dossier.events.length;

      // Debe haber nuevos eventos en el journal
      expect(eventsAfter).toBeGreaterThan(eventsBefore);
      expect(result.evicted + result.compressed).toBeGreaterThan(0);
    });
  });

  describe("taskStart / sessionEnd", () => {
    it("genera eventos de lifecycle", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      const ts = dossier.taskStart();
      expect(ts.op).toBe("task_start");
      expect(ts.entryId).toBeUndefined();
      expect(ts.actor).toBe("system");

      const se = dossier.sessionEnd();
      expect(se.op).toBe("session_end");
      expect(se.entryId).toBeUndefined();
    });
  });

  describe("live", () => {
    it("reconstruye el dossier vivo desde el journal", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      dossier.processNotes([
        { type: "decision", text: "D1" },
        { type: "gotcha", text: "G1" },
      ], "tool-1");

      const live = dossier.live;
      expect(live.size).toBe(2);

      const types = [...live.values()].map((e: Entry) => e.type).sort();
      expect(types).toEqual(["decision", "gotcha"]);
    });

    it("excluye entries evictadas", () => {
      const dossier = new Dossier(TASK_ID, { dir: TEST_DIR });

      // Crear entries y luego evictar
      dossier.processNotes([
        { type: "task", text: "T".repeat(500) },
      ], "tool-1");
      const taskId = [...dossier.live.values()].find((e: Entry) => e.type === "task")!.id;
      dossier.completeTask(taskId, "done");

      // Necesitamos una open task para que el tier alto pase highTierMinTokens
      dossier.processNotes([
        { type: "task", text: "Small task" },
      ], "tool-2");

      // Forzar evicción con budget muy chico
      dossier.evict({ maxTokens: 10, highTierMinTokens: 1 });

      const live = dossier.live;
      // La done task grande debería ser evictada
      expect(live.has(taskId)).toBe(false);
    });
  });
});
