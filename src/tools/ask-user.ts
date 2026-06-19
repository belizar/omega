import { Tool } from "./tool.js";

type AskUserInput = { question: string };

/**
 * Tool para que el agente pida confirmación o input al usuario durante la
 * ejecución. El runner intercepta esta tool: pausa el loop, muestra la
 * pregunta, y espera la respuesta del usuario antes de continuar.
 *
 * Esta implementación nunca es llamada directamente — el runner la maneja
 * como caso especial. Si por algún motivo llegara a ejecutarse, devuelve
 * un error descriptivo.
 */
export class AskUserTool extends Tool<AskUserInput, string> {
  constructor() {
    super({
      name: "ask_user",
      description:
        "Pide confirmación o input al usuario. Usala cuando necesites aprobación " +
        "antes de una acción destructiva (borrar archivos, instalar dependencias, " +
        "ejecutar comandos peligrosos) o cuando necesites que el usuario elija entre " +
        "varias opciones. El runner pausa y espera la respuesta.",
      schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "La pregunta que se le muestra al usuario. Debe ser clara y " +
              "especificar qué opciones tiene (ej: '¿Borro el archivo X? (sí/no)').",
          },
        },
        required: ["question"],
      },
    });
  }

  async execute(_input: AskUserInput): Promise<string> {
    return "Error: ask_user debe ser interceptado por el runner. Esto es un bug interno.";
  }
}
