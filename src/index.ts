import dotenv from "dotenv";
import { stdout } from "process";
import { AgentConfig } from "./agent-config.js";
import { Context } from "./app-context.js";
import { dispatchCommand } from "./commands/index.js";
import { validateEnv } from "./config.js";
import { logger } from "./logger.js";
import { OpenRouterProvider } from "./providers/openrouter-llm-provider.js";
import { Runner } from "./runner.js";
import { Session } from "./session.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { ReadTool } from "./tools/read.js";
import { WriteTool } from "./tools/write.js";
import {
  DisplayAssistantText,
  DisplayToolCall,
  DisplayToolResult,
} from "./tui/components/display-text.js";
import { LineEditor } from "./tui/components/line-editor.js";
import { Spinner } from "./tui/components/spinner.js";
import { run } from "./tui/render.js";
import { disableRawMode, enableRawMode } from "./tui/terminal.js";
import { dim } from "./tui/theme.js";

dotenv.config();

const main = async () => {
  enableRawMode();
  const config = validateEnv();
  const session = new Session({
    dir: ".omega/sessions",
    maxContextTokens: config.maxContextTokens,
  });
  logger.setLogFile(`.omega/logs/${session.id}.log`);
  logger.info("Omega agent starting", { session: session.id });

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

  const llmprovider = new OpenRouterProvider(config.openrouterApiKey!);

  const runner = new Runner({
    llmProvider: llmprovider,
    agentConfig: haikuAgent,
    maxSteps: config.maxSteps,
    maxContextTokens: config.maxContextTokens,
  });

  const spinner = new Spinner();
  const assistantText = new DisplayAssistantText();
  const toolCallText = new DisplayToolCall();
  const toolResultText = new DisplayToolResult();

  const ctx = new Context({ session, agentConfig: haikuAgent, runner });

  const lineEditor = new LineEditor();

  while (true) {
    const input = await run<string>(lineEditor);
    lineEditor.reset();

    if (input.trim() !== "") {
      lineEditor.addToHistory(input);
    }

    if (await dispatchCommand(input, ctx)) {
      continue;
    }

    if (input === "exit") {
      logger.info("Omega agent stopped");
      break;
    }

    session.addUserMessage(input);

    const iterator = runner.run(session.messages);

    spinner.start();
    let item = await iterator.next();
    spinner.stop();

    while (!item.done) {
      const { value } = item;

      if (value.type === "text") {
        assistantText.display(value.text);
      }

      if (value.type === "tool_use") {
        toolCallText.display(value.name);
      }

      if (value.type === "tool_result") {
        toolResultText.display(value.output);
      }

      if (value.type === "state") {
        session.addMessage(value.message);
      }

      spinner.start();
      item = await iterator.next();
      spinner.stop();
    }

    // Mostrar métricas de la iteración
    const metrics = runner.getMetrics();
    session.addUsage(metrics.totalInputTokens, metrics.totalOutputTokens, metrics.totalCost);
    const durationSec = (metrics.durationMs / 1000).toFixed(1);
    const costStr = metrics.totalCost < 0.01
      ? "<$0.01"
      : `${metrics.totalCost.toFixed(2)}`;
    const runningStr = session.totalCost < 0.01 ? "<$0.01" : `${session.totalCost.toFixed(2)}`;
    const metricsLine = `~ ctx: ${session.contextTokens} tk · ${metrics.totalToolCalls} tools · in: ${metrics.totalInputTokens} · out: ${metrics.totalOutputTokens} tokens · ${durationSec}s · ${costStr} (total: ${runningStr})`;
    stdout.write(`\n ${dim(metricsLine)}\n`);
    runner.resetMetrics();
  }
};

main().catch((err) => {
  disableRawMode();
  console.log(err);
  logger.error("Fatal error", err);
  process.exit(1);
});
