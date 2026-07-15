import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildSystemPrompt } from "../system-prompt.js";
import type { ResolvedConfig } from "../config.js";

const CONFIG = { docsDir: null } as unknown as ResolvedConfig;

describe("buildSystemPrompt — contexto por cwd (no por process.cwd)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omega-sysprompt-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lista los MCP del .omega/mcp.json del cwd que se le pasa", () => {
    mkdirSync(join(dir, ".omega"), { recursive: true });
    writeFileSync(
      join(dir, ".omega", "mcp.json"),
      JSON.stringify({ servers: { unicornsvc: { command: "echo", args: [] } } }),
    );
    const prompt = buildSystemPrompt(CONFIG, [], dir);
    expect(prompt).toContain("Servicios MCP disponibles");
    expect(prompt).toContain("unicornsvc"); // ← salió del cwd pasado, no de process.cwd
  });

  it("sin mcp.json en el cwd → sin sección MCP (nombre único, no colisiona con global)", () => {
    const prompt = buildSystemPrompt(CONFIG, [], dir);
    expect(prompt).not.toContain("unicornsvc");
  });
});
