import { Tool } from "./tool.js";
import { ToolDescriptor, ToolRegistry } from "./tool-registry.js";

type ToolSearchInput = { query: string };

/**
 * Meta-tool para descubrir tools disponibles. El agente la usa cuando
 * necesita algo que las tools esenciales no cubren (ej: APIs, bases de datos).
 *
 * Progressive disclosure: el LLM no recibe los schemas de todas las tools
 * posibles, solo busca bajo demanda. Después de encontrar una tool, puede
 * usarla directamente porque ya queda registrada en el ToolRegistry.
 */
export class ToolSearchTool extends Tool<ToolSearchInput, string> {
  #registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    super({
      name: "tool_search",
      description:
        "Busca tools disponibles por nombre o descripción. Usala cuando " +
        "necesites hacer algo que las tools esenciales (read, write, edit, bash, " +
        "grep, outline, ask_user) no cubren — por ejemplo: interactuar con APIs, " +
        "bases de datos, services externos, etc. Devuelve una lista de tools " +
        "matcheantes con nombre y descripción. Después de encontrar una tool, " +
        "llamala directamente: ya queda registrada para el resto de la sesión.",
      schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Término de búsqueda (ej: 'github', 'postgres', 'slack'). " +
              "Busca en nombre y descripción de todas las tools disponibles.",
          },
        },
        required: ["query"],
      },
    });
    this.#registry = registry;
  }

  async execute(input: ToolSearchInput): Promise<string> {
    const results = await this.#registry.search(input.query);

    if (results.length === 0) {
      return (
        `No se encontraron tools que coincidan con "${input.query}".\n` +
        `Probá con otros términos o verificá que el servidor MCP correspondiente esté configurado en .omega/mcp.json.`
      );
    }

    const lines = results.map((r: ToolDescriptor) => {
      const sourceTag = r.source === "local" ? "[local]" : r.serverName ? `[${r.serverName}]` : "[cached]";
      return `- **${r.name}** ${sourceTag}: ${r.description}`;
    });

    return `Tools encontradas para "${input.query}":\n\n${lines.join("\n")}\n\n` +
      `Para usar cualquiera de estas tools, llamala por nombre directamente. ` +
      `No necesitás volver a buscarla.`;
  }
}