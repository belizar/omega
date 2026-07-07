import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClearCommand } from "../../commands/clear.js";
import { RenameCommand } from "../../commands/rename.js";
import { ResumeCommand } from "../../commands/resume.js";
import { HelpCommand } from "../../commands/help.js";
import { dispatchCommand, listCommands } from "../../commands/index.js";
import { Command } from "../../commands/command.js";
import { Context } from "../../app-context.js";
import { Session } from "../../session.js";
import { AgentConfig } from "../../agent-config.js";
import { BashTool } from "../../tools/bash.js";
import { ToolRegistry } from "../../tools/tool-registry.js";

// ── Mock mínimos ─────────────────────────────────────────────────────────────

class MockScreen {
  #lines: string[] = [];

  printAbove(text: string): void {
    this.#lines.push(text);
  }

  // Para otros métodos de Screen que no usamos
  clearEphemeral(): void {}
  writeEphemeral(_text: string): void {}
  setStatus(_text: string | null): void {}
  redrawLive(): void {}

  // Helper para tests
  getLastLine(): string {
    return this.#lines[this.#lines.length - 1] ?? "";
  }

  getAllLines(): string[] {
    return [...this.#lines];
  }
}

function createMockContext(
  customCommands?: Context["customCommands"],
): Context {
  const session = new Session();
  const registry = new ToolRegistry();
  registry.registerLocal(new BashTool());
  const agentConfig = new AgentConfig({
    systemPrompt: "test",
    model: "test-model",
    maxTokens: 512,
    toolRegistry: registry,
  });
  const screen = new MockScreen() as unknown as Context["screen"];
  return new Context({ session, agentConfig, screen, toolRegistry: registry, customCommands });
}

// ── ClearCommand ─────────────────────────────────────────────────────────────

describe("ClearCommand", () => {
  it("should clear session and display confirmation", () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;
    ctx.session.addUserMessage("hello");

    const cmd = new ClearCommand();
    cmd.handler(ctx, []);

    expect(ctx.session.messages).toHaveLength(0);
    expect(screen.getLastLine()).toContain("Conversación limpia");
  });
});

// ── RenameCommand ────────────────────────────────────────────────────────────

describe("RenameCommand", () => {
  it("should show current name when no args", () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;

    const cmd = new RenameCommand();
    cmd.handler(ctx, []);

    expect(screen.getLastLine()).toContain("Nombre actual");
  });

  it("should rename session when name provided", () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;

    const cmd = new RenameCommand();
    cmd.handler(ctx, ["Mi", "Sesión"]);

    expect(ctx.session.name).toBe("Mi Sesión");
    expect(screen.getLastLine()).toContain("renombrada");
  });

  it("should reject empty name", () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;

    const cmd = new RenameCommand();
    cmd.handler(ctx, ["   "]);

    expect(screen.getLastLine()).toContain("no puede estar vacío");
  });
});

// ── ResumeCommand ────────────────────────────────────────────────────────────

describe("ResumeCommand", () => {
  it("should show no sessions message when dir is empty", () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;

    const cmd = new ResumeCommand();
    cmd.handler(ctx, []);

    expect(screen.getLastLine()).toContain("Usá /resume");
  });

  it("should show usage when no args", () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;

    const cmd = new ResumeCommand();
    cmd.handler(ctx, []);

    expect(screen.getLastLine()).toContain("Usá /resume");
  });

  it("should show not found for non-existent session id", () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;

    const cmd = new ResumeCommand();
    cmd.handler(ctx, ["nonexistent-id"]);

    expect(screen.getLastLine()).toContain("No se encontró");
  });
});

// ── HelpCommand ──────────────────────────────────────────────────────────────

describe("HelpCommand", () => {
  it("should list all registered commands", () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;

    const commandsMap: Record<string, Command<unknown>> = {
      "/clear": new ClearCommand(),
      "/rename": new RenameCommand(),
    };
    commandsMap["/help"] = new HelpCommand(commandsMap);

    const cmd = new HelpCommand(commandsMap);
    cmd.handler(ctx, []);

    const output = screen.getAllLines().join("\n");
    expect(output).toContain("Comandos disponibles");
    expect(output).toContain("/clear");
    expect(output).toContain("/rename");
    expect(output).toContain("/help");
  });

  it("should show message when no commands registered", () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;

    const cmd = new HelpCommand({});
    cmd.handler(ctx, []);

    expect(screen.getLastLine()).toContain("No hay comandos disponibles");
  });
});

// ── dispatchCommand ──────────────────────────────────────────────────────────

describe("dispatchCommand", () => {
  it("should return not-command for non-command text", async () => {
    const ctx = createMockContext();
    const result = await dispatchCommand("hola mundo", ctx);
    expect(result.kind).toBe("not-command");
  });

  it("should handle and dispatch /clear", async () => {
    const ctx = createMockContext();
    ctx.session.addUserMessage("hello");

    const result = await dispatchCommand("/clear", ctx);
    expect(result.kind).toBe("handled");
    expect(ctx.session.messages).toHaveLength(0);
  });

  it("should handle and show error for unknown command", async () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;

    const result = await dispatchCommand("/nonexistent", ctx);
    expect(result.kind).toBe("handled");
    expect(screen.getLastLine()).toContain("no reconocido");
  });

  it("should dispatch /rename with args", async () => {
    const ctx = createMockContext();

    const result = await dispatchCommand("/rename test-session", ctx);
    expect(result.kind).toBe("handled");
    expect(ctx.session.name).toBe("test-session");
  });

  it("should dispatch /help and show available commands", async () => {
    const ctx = createMockContext();
    const screen = ctx.screen as unknown as MockScreen;

    const result = await dispatchCommand("/help", ctx);
    expect(result.kind).toBe("handled");
    const output = screen.getAllLines().join("\n");
    expect(output).toContain("Comandos disponibles");
  });

  it("should expand a custom command to a prompt", async () => {
    const custom = {
      "/greet": {
        name: "/greet",
        description: "saluda",
        body: "Saludá a $1 en $ARGUMENTS",
        source: "project" as const,
      },
    };
    const ctx = createMockContext(custom);

    const result = await dispatchCommand("/greet Ana en español", ctx);
    expect(result.kind).toBe("expand");
    if (result.kind === "expand") {
      expect(result.text).toBe("Saludá a Ana en Ana en español");
    }
  });

  it("should prefer a built-in over a custom command of the same name", async () => {
    const custom = {
      "/clear": {
        name: "/clear",
        description: "custom clear",
        body: "no debería correr",
        source: "project" as const,
      },
    };
    const ctx = createMockContext(custom);

    const result = await dispatchCommand("/clear", ctx);
    expect(result.kind).toBe("handled");
  });
});

// ── listCommands ─────────────────────────────────────────────────────────────

describe("listCommands", () => {
  it("merges built-in and custom commands, sorted by name", () => {
    const custom = {
      "/deploy": {
        name: "/deploy",
        description: "deploya",
        body: "b",
        source: "project" as const,
      },
    };
    const ctx = createMockContext(custom);
    const list = listCommands(ctx);

    const names = list.map((c) => c.name);
    expect(names).toContain("/help");
    expect(names).toContain("/deploy");
    // Ordenado alfabéticamente.
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // Trae la descripción del custom.
    expect(list.find((c) => c.name === "/deploy")?.description).toBe("deploya");
  });
});