import { describe, it, expect } from "vitest";
import {
  compactStaleReads,
  truncate,
  estimateTokens,
  estimateMessagesTokens,
  pruneContext,
  lastTurns,
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

// ── compactStaleReads ────────────────────────────────────────────────────────

/** Helper: crea un turno completo user → assistant(tool_use read) → user(tool_result) */
function makeReadTurn(
  path: string,
  content: string,
  toolUseId: string,
): [Message, Message, Message] {
  const user = userText(`leé ${path}`);
  const assistant = assistantToolUse([
    { id: toolUseId, name: "read", input: { path } },
  ]);
  const toolResult = userToolResult([{ tool_use_id: toolUseId, content }]);
  return [user, assistant, toolResult];
}

/** Helper: crea un turno user → assistant(tool_use edit) → user(tool_result) */
function makeEditTurn(
  path: string,
  oldText: string,
  newText: string,
  toolUseId: string,
): [Message, Message, Message] {
  const user = userText(`editá ${path}`);
  const assistant = assistantToolUse([
    { id: toolUseId, name: "edit", input: { path, oldText, newText } },
  ]);
  const toolResult = userToolResult([{ tool_use_id: toolUseId, content: "edit exitoso" }]);
  return [user, assistant, toolResult];
}

describe("compactStaleReads", () => {
  it("no compacta reads recientes", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `línea ${i}`);
    const content = lines.join("\n");

    const turn = makeReadTurn("src/foo.ts", content, "t1");
    const msgs: Message[] = [...turn];

    const result = compactStaleReads(msgs, { staleSteps: 3, minLines: 20 });

    // Un solo paso del agente, age=0, no compacta
    expect(result).toHaveLength(3);
    const toolResult = result[2];
    expect(toolResult.role).toBe("user");
    expect(Array.isArray(toolResult.content)).toBe(true);
    const block = (toolResult.content as Array<Record<string, unknown>>)[0];
    expect(block.content).toBe(content);
  });

  it("compacta reads de más de N pasos de antigüedad", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `línea ${i}`);
    const content = lines.join("\n");

    // Paso 1: read foo.ts (1 assistant)
    const turn1 = makeReadTurn("src/foo.ts", content, "t1");
    // Pasos 2-7: seis turnos de user+assistant más (6 assistants)
    // Total: 7 assistants. Read en step=1, currentStep=7, age=6 > 3 → compactado
    const msgs: Message[] = [
      ...turn1,
      userText("turno 2"), assistantText("respuesta 2"),
      userText("turno 3"), assistantText("respuesta 3"),
      userText("turno 4"), assistantText("respuesta 4"),
      userText("turno 5"), assistantText("respuesta 5"),
      userText("turno 6"), assistantText("respuesta 6"),
      userText("turno 7"), assistantText("respuesta 7"),
    ];

    const result = compactStaleReads(msgs, { staleSteps: 3, minLines: 20 });

    // read en step=1, currentStep=7, age=6 > 3 → compactado
    const toolResult = result[2];
    const block = (toolResult.content as Array<Record<string, unknown>>)[0];
    expect(typeof block.content).toBe("string");
    expect(block.content as string).toContain("[leído src/foo.ts hace 6 pasos");
    expect(block.content as string).toContain("usá read para verlo de nuevo");
  });

  it("no compacta reads con pocas líneas", () => {
    const content = "pocas líneas\nsolo dos";

    const turn1 = makeReadTurn("src/foo.ts", content, "t1");
    const msgs: Message[] = [
      ...turn1,
      userText("turno 2"), assistantText("respuesta 2"),
      userText("turno 3"), assistantText("respuesta 3"),
      userText("turno 4"), assistantText("respuesta 4"),
      userText("turno 5"), assistantText("respuesta 5"),
      userText("turno 6"), assistantText("respuesta 6"),
      userText("turno 7"), assistantText("respuesta 7"),
    ];

    const result = compactStaleReads(msgs, { staleSteps: 3, minLines: 20 });

    // El contenido debe estar intacto (pocas líneas, < minLines)
    const toolResult = result[2];
    const block = (toolResult.content as Array<Record<string, unknown>>)[0];
    expect(block.content).toBe(content);
  });

  it("invalida reads de archivos editados después", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `línea ${i}`);
    const content = lines.join("\n");

    // Paso 1: read foo.ts (1 assistant)
    const turn1 = makeReadTurn("src/foo.ts", content, "t1");
    // Paso 2: edit foo.ts (1 assistant)
    const turn2 = makeEditTurn("src/foo.ts", "viejo", "nuevo", "t2");
    // Paso 3: user actual
    const msgs: Message[] = [
      ...turn1,
      ...turn2,
      userText("turno 3"),
    ];

    const result = compactStaleReads(msgs, { staleSteps: 3, minLines: 20 });

    // El read del paso 1 fue invalidado por edit del paso 2
    const toolResult = result[2];
    const block = (toolResult.content as Array<Record<string, unknown>>)[0];
    expect(typeof block.content).toBe("string");
    expect(block.content as string).toContain("fue editado después");
  });

  it("no invalida reads de archivos no editados", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `línea ${i}`);
    const content = lines.join("\n");

    // Paso 1: read foo.ts, read bar.ts (1 assistant con 2 tool_uses)
    const turn1User = userText("leé estos archivos");
    const turn1Assistant = assistantToolUse([
      { id: "t1", name: "read", input: { path: "src/foo.ts" } },
      { id: "t2", name: "read", input: { path: "src/bar.ts" } },
    ]);
    const turn1Result = userToolResult([
      { tool_use_id: "t1", content },
      { tool_use_id: "t2", content },
    ]);

    // Paso 2: edit foo.ts (1 assistant)
    const turn2 = makeEditTurn("src/foo.ts", "viejo", "nuevo", "t3");

    // Paso 3: user actual
    const msgs: Message[] = [
      turn1User,
      turn1Assistant,
      turn1Result,
      ...turn2,
      userText("turno 3"),
    ];

    const result = compactStaleReads(msgs, { staleSteps: 3, minLines: 20 });

    // foo.ts fue editado → invalidado
    const toolResult = result[2];
    const blocks = toolResult.content as Array<Record<string, unknown>>;
    expect(blocks[0].content as string).toContain("fue editado después");
    // bar.ts NO fue editado → intacto
    expect(blocks[1].content).toBe(content);
  });

  it("no muta el array original", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `línea ${i}`);
    const content = lines.join("\n");

    const turn = makeReadTurn("src/foo.ts", content, "t1");
    const msgs: Message[] = [
      ...turn,
      userText("turno 2"), assistantText("respuesta 2"),
      userText("turno 3"), assistantText("respuesta 3"),
      userText("turno 4"), assistantText("respuesta 4"),
      userText("turno 5"), assistantText("respuesta 5"),
      userText("turno 6"), assistantText("respuesta 6"),
      userText("turno 7"), assistantText("respuesta 7"),
    ];

    const original = JSON.stringify(msgs);
    compactStaleReads(msgs, { staleSteps: 3, minLines: 20 });
    expect(JSON.stringify(msgs)).toBe(original);
  });

  it("devuelve el mismo array si no hay nada que compactar", () => {
    const msgs: Message[] = [
      userText("hola"),
      assistantText("qué tal"),
    ];

    const result = compactStaleReads(msgs);
    // Mismas referencias si no se compactó nada
    expect(result).toEqual(msgs);
  });

  it("maneja arrays vacíos", () => {
    const result = compactStaleReads([]);
    expect(result).toEqual([]);
  });

  it("maneja reads sin path (input mal formado)", () => {
    // Varias líneas para superar minLines
    const lines = Array.from({ length: 30 }, (_, i) => `linea ${i}`);
    const content = lines.join("\n");
    const user = userText("leé");
    const assistant = assistantToolUse([
      { id: "t1", name: "read", input: {} },
    ]);
    const toolResult = userToolResult([{ tool_use_id: "t1", content }]);

    const msgs: Message[] = [
      user,
      assistant,
      toolResult,
      userText("turno 2"), assistantText("r2"),
      userText("turno 3"), assistantText("r3"),
      userText("turno 4"), assistantText("r4"),
      userText("turno 5"), assistantText("r5"),
      userText("turno 6"), assistantText("r6"),
      userText("turno 7"), assistantText("r7"),
    ];

    const result = compactStaleReads(msgs, { staleSteps: 3, minLines: 20 });
    const block = (result[2].content as Array<Record<string, unknown>>)[0];
    expect(block.content as string).toContain("[leído desconocido hace");
    expect(block.content as string).toContain("pasos");
  });

  it("un marcador ya compactado no se re-compacta (idempotencia)", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `línea ${i}`);
    const content = lines.join("\n");

    // Paso 1: read
    const turn1 = makeReadTurn("src/foo.ts", content, "t1");
    const msgs: Message[] = [
      ...turn1,
      userText("turno 2"), assistantText("r2"),
      userText("turno 3"), assistantText("r3"),
      userText("turno 4"), assistantText("r4"),
      userText("turno 5"), assistantText("r5"),
      userText("turno 6"), assistantText("r6"),
      userText("turno 7"), assistantText("r7"),
    ];

    // Primera compactación: currentStep=7, read step=1, age=6 > 3 → compactado
    const pass1 = compactStaleReads(msgs, { staleSteps: 3, minLines: 20 });
    const block1 = (pass1[2].content as Array<{ content: string }>)[0];
    expect(block1.content).toContain("hace 6 pasos");

    // Segunda pasada con más mensajes: el marcador NO debe cambiar (idempotente)
    // porque el lineCount parseado del marcador es 1 < minLines
    const moreMsgs: Message[] = [
      ...pass1,
      userText("turno 8"), assistantText("r8"),
      userText("turno 9"), assistantText("r9"),
      userText("turno 10"), assistantText("r10"),
      userText("turno 11"), assistantText("r11"),
      userText("turno 12"), assistantText("r12"),
      userText("turno 13"),
    ];

    const pass2 = compactStaleReads(moreMsgs, { staleSteps: 3, minLines: 20 });
    const block2 = (pass2[2].content as Array<{ content: string }>)[0];
    // Debe seguir diciendo "hace 6 pasos", NO "hace X" con X > 6
    expect(block2.content).toContain("hace 6 pasos");
  });

  it("invalida por edición aunque el archivo tenga pocas líneas", () => {
    const content = "pocas líneas\nsolo dos"; // 2 líneas, < minLines

    // Paso 1: read chico
    const turn1 = makeReadTurn("src/foo.ts", content, "t1");
    // Paso 2: edit
    const turn2 = makeEditTurn("src/foo.ts", "viejo", "nuevo", "t2");
    // Paso 3: user actual
    const msgs: Message[] = [...turn1, ...turn2, userText("turno 3")];

    const result = compactStaleReads(msgs, { staleSteps: 3, minLines: 20 });

    // Debe invalidarse por edición aunque el archivo sea chico
    const toolResult = result[2];
    const block = (toolResult.content as Array<Record<string, unknown>>)[0];
    expect(block.content as string).toContain("fue editado después");
  });

  it("preserva is_error al compactar por edición", () => {
    const content = "archivo con error\ndos líneas";

    // Paso 1: read fallido
    const turn1User = userText("leé esto");
    const turn1Assistant = assistantToolUse([
      { id: "t1", name: "read", input: { path: "src/err.ts" } },
    ]);
    const turn1Result: Message = {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content,
        is_error: true,  // read falló
      }],
    };

    // Paso 2: edit (para disparar invalidación)
    const turn2 = makeEditTurn("src/err.ts", "x", "y", "t2");

    // Paso 3: user
    const msgs: Message[] = [
      turn1User, turn1Assistant, turn1Result,
      ...turn2,
      userText("turno 3"),
    ];

    const result = compactStaleReads(msgs, { staleSteps: 3, minLines: 20 });
    const toolResult = result[2];
    const block = (toolResult.content as Array<Record<string, unknown>>)[0];
    expect(block.is_error).toBe(true);
  });

  it("dispara compactación en tarea agéntica de un solo turno (escenario real)", () => {
    // Escenario real: 1 mensaje del usuario, N pasos internos del agente.
    // Cada paso es: assistant(tool_use) → user(tool_result) → assistant(text).
    // Con métrica de turnos de usuario esto NUNCA compactaba (1 solo turno).
    // Con métrica de pasos del agente, los reads viejos SÍ se compactan.
    const lines = Array.from({ length: 30 }, (_, i) => `línea ${i}`);
    const content = lines.join("\n");

    // Un solo mensaje del usuario
    const msgs: Message[] = [userText("hacé una tarea compleja que requiera varios pasos")];

    // Paso 1: read archivo A
    msgs.push(assistantToolUse([{ id: "r1", name: "read", input: { path: "src/a.ts" } }]));
    msgs.push(userToolResult([{ tool_use_id: "r1", content }]));
    msgs.push(assistantText("leí A, ahora voy por B"));

    // Paso 2: read archivo B
    msgs.push(assistantToolUse([{ id: "r2", name: "read", input: { path: "src/b.ts" } }]));
    msgs.push(userToolResult([{ tool_use_id: "r2", content }]));
    msgs.push(assistantText("leí B"));

    // Paso 3: read archivo C
    msgs.push(assistantToolUse([{ id: "r3", name: "read", input: { path: "src/c.ts" } }]));
    msgs.push(userToolResult([{ tool_use_id: "r3", content }]));
    msgs.push(assistantText("leí C"));

    // Paso 4: read archivo D
    msgs.push(assistantToolUse([{ id: "r4", name: "read", input: { path: "src/d.ts" } }]));
    msgs.push(userToolResult([{ tool_use_id: "r4", content }]));
    msgs.push(assistantText("leí D"));

    // Paso 5: read archivo E
    msgs.push(assistantToolUse([{ id: "r5", name: "read", input: { path: "src/e.ts" } }]));
    msgs.push(userToolResult([{ tool_use_id: "r5", content }]));
    msgs.push(assistantText("leí E"));

    // Paso 6: read archivo F
    msgs.push(assistantToolUse([{ id: "r6", name: "read", input: { path: "src/f.ts" } }]));
    msgs.push(userToolResult([{ tool_use_id: "r6", content }]));
    msgs.push(assistantText("terminé"));

    // Con métrica de turnos de usuario: solo 1 turno → 0 compactaciones.
    // Con la nueva métrica de pasos: cada assistant es un paso.
    //   r1 step=1, r2 step=3, r3 step=5, r4 step=7, r5 step=9, r6 step=11
    //   currentStep = 12 (6 tool_use assistants + 6 text assistants)
    const result = compactStaleReads(msgs, { staleSteps: 5, minLines: 20 });

    // r1 (índice 2): step=1, age=12-1=11 > 5 → compactado
    const r1Block = (result[2].content as Array<{ content: string }>)[0];
    expect(r1Block.content).toContain("hace 11 pasos");

    // r2 (índice 5): step=3, age=12-3=9 > 5 → compactado
    const r2Block = (result[5].content as Array<{ content: string }>)[0];
    expect(r2Block.content).toContain("hace 9 pasos");

    // r6 (índice 17): step=11, age=12-11=1, no > 5 → intacto
    const r6Block = (result[17].content as Array<{ content: string }>)[0];
    expect(r6Block.content).toBe(content);
  });
});

// ── lastTurns (windowing por K turnos) ───────────────────────────────────────

describe("lastTurns", () => {
  it("devuelve array vacío si no hay mensajes", () => {
    expect(lastTurns([], 4)).toEqual([]);
  });

  it("devuelve array vacío si k <= 0", () => {
    const msgs: Message[] = [userText("hola"), assistantText("qué tal")];
    expect(lastTurns(msgs, 0)).toEqual([]);
    expect(lastTurns(msgs, -1)).toEqual([]);
  });

  it("devuelve exactamente las últimas K turnos", () => {
    const msgs: Message[] = [
      userText("turno 1"),
      assistantText("respuesta 1"),
      userText("turno 2"),
      assistantText("respuesta 2"),
      userText("turno 3"),
      assistantText("respuesta 3"),
      userText("turno 4"),
      assistantText("respuesta 4"),
      userText("turno 5"),
      assistantText("respuesta 5"),
    ];

    const result = lastTurns(msgs, 2);

    // Debe empezar en "turno 4" (el tercer turno contando desde atrás: 5, 4 => k=2)
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toEqual(userText("turno 4"));
    // Debe contener turno 4 y turno 5 completos
    expect(result).toContainEqual(userText("turno 4"));
    expect(result).toContainEqual(assistantText("respuesta 4"));
    expect(result).toContainEqual(userText("turno 5"));
    expect(result).toContainEqual(assistantText("respuesta 5"));
    // NO debe contener el turno 3
    expect(result).not.toContainEqual(userText("turno 3"));
  });

  it("con k mayor al total de turnos devuelve todo sin romper", () => {
    const msgs: Message[] = [
      userText("turno 1"),
      assistantText("respuesta 1"),
      userText("turno 2"),
      assistantText("respuesta 2"),
    ];

    const result = lastTurns(msgs, 10);

    expect(result.length).toBe(4);
    expect(result[0]).toEqual(userText("turno 1"));
    expect(result[result.length - 1]).toEqual(assistantText("respuesta 2"));
  });

  it("NUNCA empieza en un tool_result huérfano", () => {
    // Simula: user("leé X"), assistant(tool_use read), user(tool_result ENORME),
    //         assistant("listo"), user("gracias")
    // Con k=1, sin orphan-safety empezaría en el tool_result.
    // Con orphan-safety, debe avanzar hasta el user("gracias") o incluir el turno completo.
    const msgs: Message[] = [
      userText("leé el archivo"),
      assistantToolUse([{ id: "t1", name: "read", input: { path: "x.ts" } }]),
      userToolResult([{ tool_use_id: "t1", content: "contenido enorme ".repeat(500) }]),
      assistantText("listo, ya lo leí"),
      userText("gracias, ahora editá la línea 3"),
    ];

    const result = lastTurns(msgs, 1);

    // No debe empezar con un tool_result huérfano
    const first = result[0];
    const isToolResult =
      first.role === "user" &&
      Array.isArray(first.content) &&
      first.content.some(
        (b: unknown) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result",
      );
    expect(isToolResult).toBe(false);

    // Debe empezar en un user de texto real
    expect(first.role).toBe("user");
    expect(typeof first.content).toBe("string");
  });

  it("NUNCA deja un tool_use sin su tool_result (turn-aware)", () => {
    // Caso crítico: el corte cae justo después de un assistant con tool_use
    // pero antes del tool_result. Debe incluir el tool_result o no incluir el
    // tool_use.
    const msgs: Message[] = [
      userText("turno 1"),
      assistantText("respuesta 1"),
      userText("hacé una búsqueda"),
      assistantToolUse([{ id: "g1", name: "grep", input: { pattern: "foo" } }]),
      userToolResult([{ tool_use_id: "g1", content: "resultados del grep" }]),
      assistantText("encontré 3 matches, voy a leer uno"),
      assistantToolUse([{ id: "r1", name: "read", input: { path: "a.ts" } }]),
      userToolResult([{ tool_use_id: "r1", content: "contenido de a.ts" }]),
      assistantText("listo, este es el contenido"),
      userText("gracias"),
    ];

    const result = lastTurns(msgs, 2);

    // Verificar que no hay tool_use sin su tool_result correspondiente
    // Recorremos y trackeamos tool_use_ids vistos
    const seenToolUses = new Set<string>();
    const completedToolUses = new Set<string>();

    for (const msg of result) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && "type" in block && block.type === "tool_use" && "id" in block) {
            seenToolUses.add(block.id as string);
          }
        }
      }
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && "type" in block && block.type === "tool_result" && "tool_use_id" in block) {
            completedToolUses.add(block.tool_use_id as string);
          }
        }
      }
    }

    // Todo tool_use presente debe tener su tool_result
    for (const id of seenToolUses) {
      expect(completedToolUses.has(id)).toBe(true);
    }
  });

  it("devuelve solo el último turno con k=1", () => {
    const msgs: Message[] = [
      userText("turno 1"),
      assistantText("respuesta 1"),
      userText("turno 2"),
      assistantText("respuesta 2"),
      userText("turno 3"),
      assistantText("respuesta 3"),
    ];

    const result = lastTurns(msgs, 1);

    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toEqual(userText("turno 3"));
    expect(result[result.length - 1]).toEqual(assistantText("respuesta 3"));
  });

  it("no se rompe con mensajes que tienen content string (no array)", () => {
    const msgs: Message[] = [
      { role: "user", content: "texto simple" },
      assistantText("respuesta simple"),
    ];

    const result = lastTurns(msgs, 1);
    expect(result.length).toBe(2);
    expect(result[0]).toEqual({ role: "user", content: "texto simple" });
  });
});
