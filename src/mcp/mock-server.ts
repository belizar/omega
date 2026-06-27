/**
 * Server MCP mock para testing.
 * Habla JSON-RPC sobre stdio: lee línea por línea de stdin, responde en stdout.
 * Soporta: initialize, tools/list, tools/call.
 *
 * Uso: node dist/mcp-mock-server.js
 */
const serverInfo = {
  name: "mock-server",
  version: "1.0.0",
};

const tools = [
  {
    name: "mock_echo",
    description: "Devuelve el input que recibe. Herramienta de prueba.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Mensaje a devolver" },
      },
      required: ["message"],
    },
  },
  {
    name: "mock_health",
    description: "Devuelve información de salud del servidor mock.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

function send(response: unknown): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function handleRequest(msg: { id: number; method: string; params: unknown }): void {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo,
          capabilities: { tools: {} },
        },
      });
      break;

    case "tools/list":
      send({
        jsonrpc: "2.0",
        id,
        result: { tools },
      });
      break;

    case "tools/call": {
      const p = params as { name: string; arguments: unknown };
      if (p.name === "mock_echo") {
        const args = p.arguments as { message: string };
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Echo: ${args.message}` }],
          },
        });
      } else if (p.name === "mock_health") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: `Mock server running. PID: ${process.pid}. Uptime: ${process.uptime().toFixed(0)}s`,
              },
            ],
          },
        });
      } else {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unknown tool: ${p.name}` },
        });
      }
      break;
    }

    default:
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      });
  }
}

// Leer línea por línea de stdin
let buffer = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id) {
        handleRequest(msg);
      }
    } catch {
      // Ignorar líneas inválidas
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

// Para que no muera solo
process.stdin.resume();