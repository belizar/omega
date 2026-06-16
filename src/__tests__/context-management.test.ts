import { describe, it, expect } from "vitest";
import {
  truncate,
  estimateTokens,
  estimateMessagesTokens,
  pruneContext,
} from "../context-management.js";
import { Message } from "../message.js";

// ── Helpers para construir mensajes ──────────────────────────────────────────

function userText(text: string): Message {
  return { role: "user", content: text };
}

function assistantText(text: string): Message {
  return { role: "assistant", content: text };
}

function assistantToolUse(blocks: Array<{ id: string; name: string; input: unknown }>): Message {
  return {
    role: "assistant",
    content: blocks.map((b) => ({ type: "tool_use" as const, ...b })),
  };
}

function userToolResult(results: Array<{ tool_use_id: string; content: string }>): Message {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result" as const,
      ...r,
      is_error: false,
    })),
  };
}

// ── truncate ─────────────────────────────────────────────────────────────────

describe("truncate", () => {
  it("no trunca texto corto", () => {
    const text = "hola\nchau";
    expect(truncate(text, 10)).toBe(text);
  });

  it("trunca cuando excede maxLines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `linea ${i}`);
    const text = lines.join("\n");
    const result = truncate(text, 20);
    expect(result).toContain("líneas omitidas");
    const resultLines = result.split("\n");
    expect(resultLines.length).toBeLessThanOrEqual(23); // 10 head + \n + marker + \n + \n + 10 tail
  });

  it("conserva primeras y últimas líneas", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `linea ${i}`);
    const text = lines.join("\n");
    const result = truncate(text, 20);
    expect(result).toContain("linea 0");
    expect(result).toContain("linea 99");
  });
});

// ── estimateTokens ───────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("estima ~3 chars por token", () => {
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2); // ceil(4/3) = 2
  });

  it("devuelve 0 para string vacío", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

// ── estimateMessagesTokens ───────────────────────────────────────────────────

describe("estimateMessagesTokens", () => {
  it("acumula tokens de varios mensajes", () => {
    const msgs: Message[] = [
      userText("hola"),
      assistantText("qué tal"),
    ];
    const total = estimateMessagesTokens(msgs);
    expect(total).toBeGreaterThan(0);
  });

  it("devuelve 0 para array vacío", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

// ── pruneContext (turn-aware) ────────────────────────────────────────────────

describe("pruneContext", () => {
  it("devuelve array vacío si no hay mensajes", () => {
    expect(pruneContext([], 1000)).toEqual([]);
  });

  it("devuelve todos los mensajes si entran en el presupuesto", () => {
    const msgs: Message[] = [
      userText("hola"),
      assistantText("qué tal"),
    ];
    const result = pruneContext(msgs, 1_000_000);
    expect(result).toEqual(msgs);
  });

  it("recorta desde el más antiguo cuando excede presupuesto", () => {
    // Crear varios turnos user/assistant largos
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(userText(`mensaje del usuario numero ${i} con algo de relleno`));
      msgs.push(assistantText(`respuesta del asistente numero ${i} con mas relleno`));
    }

    const allTokens = estimateMessagesTokens(msgs);
    const budget = Math.floor(allTokens * 0.3); // solo 30% entra
    const result = pruneContext(msgs, budget);

    // Debe devolver menos mensajes
    expect(result.length).toBeLessThan(msgs.length);
    // El primer mensaje debe ser un user de texto
    expect(result[0].role).toBe("user");
    // El último mensaje debe ser el último del original
    expect(result[result.length - 1]).toEqual(msgs[msgs.length - 1]);
  });

  it("nunca deja un assistant como primer mensaje", () => {
    // Si el corte deja un assistant al principio, debe avanzar al siguiente user
    const msgs: Message[] = [
      userText("turno 1"),
      assistantText("respuesta 1"),
      userText("turno 2"),
      assistantText("respuesta 2"),
      userText("turno 3"),
      assistantText("respuesta 3"),
    ];

    // Budget tan chico que solo entren los últimos mensajes
    const lastTwo = msgs.slice(-2);
    const budget = estimateMessagesTokens(lastTwo) + 10; // solo entran los últimos 2

    const result = pruneContext(msgs, budget);

    // El primer mensaje NO puede ser assistant
    expect(result[0].role).toBe("user");
    // Si budget daba para [user("turno 3"), assistant("respuesta 3")], está bien
    // Si daba para [assistant("respuesta 2"), user("turno 3"), assistant("respuesta 3")],
    // debe haber avanzado para que el primero sea user("turno 3")
  });

  it("evita tool_results huérfanos al principio", () => {
    // Simula: user, assistant(tool_use), user(tool_results), assistant, user
    // Si el corte cae entre assistant(tool_use) y user(tool_results),
    // debe avanzar para incluir el tool_use o descartar el tool_result
    const msgs: Message[] = [
      userText("hacé algo"),
      assistantToolUse([{ id: "t1", name: "read", input: { path: "a.ts" } }]),
      userToolResult([{ tool_use_id: "t1", content: "contenido largo ".repeat(500) }]),
      assistantText("listo, leí el archivo"),
      userText("gracias"),
    ];

    // Budget: que entre el último user + assistant, pero el tool_result es enorme
    // y fuerza el corte en medio del turno tool
    const budget = estimateMessagesTokens([
      assistantText("listo, leí el archivo"),
      userText("gracias"),
    ]) + 50;

    const result = pruneContext(msgs, budget);

    // No debe haber tool_results huérfanos al inicio
    const first = result[0];
    const isToolResult =
      first.role === "user" &&
      Array.isArray(first.content) &&
      first.content.some(
        (b: unknown) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
      );
    expect(isToolResult).toBe(false);

    // El primer mensaje debe ser un user de texto
    expect(first.role).toBe("user");
  });

  it("maneja turno gigante (único turno > budget)", () => {
    // Un solo turno con tool_results gigantes que exceden el budget
    const msgs: Message[] = [
      userText("hacé algo con archivos grandes"),
      assistantToolUse([
        { id: "t1", name: "read", input: { path: "big.ts" } },
        { id: "t2", name: "read", input: { path: "huge.ts" } },
      ]),
      userToolResult([
        { tool_use_id: "t1", content: "x".repeat(50_000) },
        { tool_use_id: "t2", content: "y".repeat(50_000) },
      ]),
      assistantText("listo"),
      userText("gracias"),
    ];

    // Budget muy chico, ni el turno actual entra completo
    const result = pruneContext(msgs, 100);

    // Al menos debe devolver algo que empiece con user de texto
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].role).toBe("user");

    // No tool_results huérfanos
    const first = result[0];
    const isToolResult =
      first.role === "user" &&
      Array.isArray(first.content) &&
      first.content.some(
        (b: unknown) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
      );
    expect(isToolResult).toBe(false);
  });

  it("conserva el último mensaje (el input del usuario)", () => {
    const msgs: Message[] = [
      userText("turno 1"),
      assistantText("respuesta 1"),
      userText("turno 2"),
      assistantText("respuesta 2"),
      userText("turno 3"),
    ];

    const budget = estimateMessagesTokens([userText("turno 3")]) + 5;
    const result = pruneContext(msgs, budget);

    expect(result.length).toBeGreaterThan(0);
    expect(result[result.length - 1]).toEqual(userText("turno 3"));
  });

  it("no rompe con mensajes user que tienen content string", () => {
    const msgs: Message[] = [
      userText("hola"),
      assistantText("respuesta"),
    ];

    // Budget amplio: todo entra
    const result = pruneContext(msgs, 1_000_000);
    expect(result).toEqual(msgs);
  });

  it("no rompe con content mixto (string en vez de array)", () => {
    // Un user con content string simple
    const msgs: Message[] = [
      { role: "user", content: "texto simple" },
      assistantText("respuesta"),
    ];
    const result = pruneContext(msgs, 1_000_000);
    expect(result).toEqual(msgs);
  });
});
