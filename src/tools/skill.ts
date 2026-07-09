import { Skill } from "../skills.js";
import { Tool } from "./tool.js";

type SkillInput = { name: string };

/**
 * Meta-tool para cargar una skill bajo demanda. El system prompt lista las
 * skills disponibles (name + description); cuando la tarea matchea una, el agente
 * llama a esta tool con el name y recibe las instrucciones completas.
 *
 * Es progressive disclosure, gemela de tool_search: el body pesado de cada skill
 * no ocupa contexto hasta que hace falta.
 */
export class SkillTool extends Tool<SkillInput, string> {
  #skills: Map<string, Skill>;

  constructor(skills: Skill[]) {
    super({
      name: "skill",
      description:
        "Cargá una skill: una guía con instrucciones detalladas para una tarea " +
        "o capacidad específica. Las skills disponibles están listadas en el " +
        "system prompt (sección 'Skills disponibles') con su name y para qué " +
        "sirven. Cuando una tarea matchee la descripción de una skill, llamá a " +
        "esta tool con su name ANTES de empezar, y seguí sus instrucciones. " +
        "Devuelve el contenido completo de la skill.",
      schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "El name exacto de la skill a cargar (como figura en el system prompt).",
          },
        },
        required: ["name"],
      },
    });
    this.#skills = new Map(skills.map((s) => [s.name, s]));
  }

  async execute(input: SkillInput): Promise<string> {
    // Tolerante: acepta el name con o sin barra por si el modelo la agrega.
    const skill = this.#skills.get(input.name) ?? this.#skills.get(input.name.replace(/^\//, ""));

    if (!skill) {
      const available = [...this.#skills.keys()].map((n) => `"${n}"`).join(", ");
      return (
        `No existe una skill llamada "${input.name}". ` +
        (available ? `Disponibles: ${available}.` : "No hay skills instaladas.")
      );
    }

    return (
      `# Skill: ${skill.name}\n\n${skill.body}\n\n` +
      `---\n` +
      `Archivos de esta skill (si el body los referencia) están en: ${skill.dir}\n` +
      `Leelos con \`read\` usando esa ruta. Seguí las instrucciones de arriba.`
    );
  }
}
