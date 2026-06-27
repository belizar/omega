/**
 * Verificación programática del fix de zombies MCP.
 *
 * Simula el flujo real:
 * 1. ToolRegistry configura un server MCP (mock).
 * 2. tool_search conecta y spawnea el proceso hijo.
 * 3. Verificamos que el proceso hijo está VIVO.
 * 4. disconnectAll() mata el proceso.
 * 5. Verificamos que el proceso hijo está MUERTO.
 *
 * Ejecutar con: node --import tsx src/mcp/verify-zombie-fix.ts
 */
import { execSync } from "child_process";
import { McpClient } from "./mcp-client.js";
import { ToolRegistry } from "../tools/tool-registry.js";

function countProcesses(pattern: string): number {
  try {
    const out = execSync(`ps aux | grep "${pattern}" | grep -v grep | grep -v "verify-zombie"`, {
      encoding: "utf-8",
    });
    return out.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const registry = new ToolRegistry();

  registry.configureMcp({
    mock: {
      command: "node",
      args: ["dist/mcp/mock-server.js"],
      env: {},
    },
  });

  const before = countProcesses("mock-server");
  console.log(`Antes de search: ${before} procesos mock-server`);

  // Esto spawnea el proceso hijo (lazy connect)
  const results = await registry.search("mock_echo");
  console.log(`Resultados search: ${results.map((r) => r.name).join(", ")}`);

  const after = countProcesses("mock-server");
  console.log(`Después de search: ${after} procesos mock-server (esperado: 1)`);

  if (after !== 1) {
    console.error(`❌ ERROR: Se esperaba 1 proceso mock-server, hay ${after}`);
    process.exit(1);
  }
  console.log("✅ Proceso hijo VIVO — OK");

  // Esto es lo que hace process.on("exit")
  registry.disconnectAll();
  console.log("disconnectAll() ejecutado");

  // Pequeña pausa para que el kill se propague
  await new Promise((r) => setTimeout(r, 200));

  const final = countProcesses("mock-server");
  console.log(`Después de disconnectAll: ${final} procesos mock-server (esperado: 0)`);

  if (final !== 0) {
    console.error(`❌ ERROR: Quedaron ${final} procesos zombies`);
    // Matarlos manualmente para limpiar
    execSync('pkill -f "mock-server" 2>/dev/null || true');
    process.exit(1);
  }
  console.log("✅ Proceso hijo MUERTO — OK, sin zombies");
  console.log("\n🎉 Fix verificado: disconnectAll() mata procesos MCP hijos correctamente");
}

main().catch((err) => {
  console.error("Error en verificación:", err);
  // Limpiar
  try { execSync('pkill -f "mock-server" 2>/dev/null || true'); } catch { /* ok */ }
  process.exit(1);
});