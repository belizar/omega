import dotenv from "dotenv";
import { AgentConfig } from "./agent-config.js";
import { AnthropicProvider } from "./providers/anthropic-llm-provider.js";
import { Runner } from "./runner.js";
import { Session } from "./session.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { ReadTool } from "./tools/read.js";
import { WriteTool } from "./tools/write.js";
import { REPL } from "./transport.js";
import { validateEnv } from "./config.js";
import { logger } from "./logger.js";

dotenv.config();

const config = validateEnv();

const main = async () => {
  logger.info("Omega agent starting");
  const repl = new REPL();
  const session = new Session();

  const haikuAgent = new AgentConfig({
    systemPrompt: `Sos omega, un asistente de coding que trabaja en el proyecto del usuario.
                    Tenés tools para leer, escribir, editar y ejecutar comandos.

                    Tools:
                    - read: leé un archivo antes de editarlo.
                    - bash: explorá el proyecto (ls, grep, find) y ejecutá comandos.
                    - edit: para cambios quirúrgicos; el texto a reemplazar debe matchear exacto.
                    - write: solo para archivos nuevos o reescrituras completas.

                    Cómo trabajás:
                    - Explorá lo necesario antes de cambiar nada: leé los archivos relevantes
                      para entender el contexto.
                    - Después de editar código, verificá que no rompiste nada (typecheck, tests
                      o lint según el proyecto) y corregí si hace falta.
                    - Actuá solo en lo rutinario, pero pará y pedí confirmación antes de instalar
                      dependencias, borrar archivos, o cualquier comando destructivo o irreversible.

                    Estilo:
                    - Respondé siempre en español.
                    - Sé conciso: explicá brevemente qué hiciste y por qué, sin resúmenes largos.
                    - Texto plano. Sin emojis ni formato decorativo.`,
    model: config.model,
    maxTokens: config.maxTokens,
  });

  haikuAgent
    .addTool(new BashTool())
    .addTool(new ReadTool())
    .addTool(new EditTool())
    .addTool(new WriteTool());

  const anthropic = new AnthropicProvider(config.anthropicApiKey);

  const runner = new Runner({
    llmProvider: anthropic,
    agentConfig: haikuAgent,
    maxSteps: config.maxSteps,
  });

  while (true) {
    const input = await repl.input();
    if (input === "exit") {
      repl.close();
      logger.info("Omega agent stopped");
      break;
    }

    session.addUserMessage(input);

    const iterator = runner.run(session.messages);

    let item = await iterator.next();
    while (!item.done) {
      const { value } = item;

      if (value.type === "text") {
        repl.print(value.text);
      }

      if (value.type === "tool_result") {
        repl.print(value.output);
      }

      if (value.type === "state") {
        session.addMessage(value.message);
      }

      item = await iterator.next();
    }
  }
};

main().catch((err) => {
  logger.error("Fatal error", err);
  process.exit(1);
});
