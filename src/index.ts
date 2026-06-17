#!/usr/bin/env node
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import dotenv from "dotenv";
import { AgentConfig } from "./agent-config.js";
import { Context } from "./app-context.js";
import { dispatchCommand, modalCommandsMap } from "./commands/index.js";
import { validateEnv } from "./config.js";
import { logger } from "./logger.js";
import { OpenRouterProvider } from "./providers/openrouter-llm-provider.js";
import { Runner, RunnerEvent } from "./runner.js";
import { Message } from "./message.js";
import { Session } from "./session.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { GrepTool } from "./tools/grep.js";
import { ReadTool } from "./tools/read.js";
import { WriteTool } from "./tools/write.js";
import {
  DisplayAssistantText,
  DisplayToolCall,
  DisplayToolResult,
} from "./tui/components/display-text.js";
import { LineEditor } from "./tui/components/line-editor.js";
import { Prompt } from "./tui/components/prompt.js";
import { Spinner } from "./tui/components/spinner.js";
import { Screen } from "./tui/screen.js";
import { disableRawMode, enableRawMode } from "./tui/terminal.js";
import { dim } from "./tui/theme.js";
import { expandFileMentions } from "./file-mentions.js";

// Carga la .env del cwd (overrides por proyecto) y, como fallback, la global
// ~/.omega/.env. dotenv NO pisa vars ya seteadas, así que el cwd gana y la
// global completa el resto (tu API key) → `omega` anda desde cualquier carpeta.
dotenv.config();
dotenv.config({ path: join(homedir(), ".omega", ".env") });

const SYSTEM_PROMPT = `Sos omega, un asistente de coding que trabaja en el proyecto del usuario.
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
- Texto plano. Sin emojis ni formato decorativo.`;

function loadProjectContext(): string {
  const path = "AGENT.md";
  if (!existsSync(path)) return "";
  const content = readFileSync(path, "utf-8").trim();
  if (!content) return "";
  return `\n\n## Contexto del proyecto (${path})\n\n${content}`;
}

const main = async () => {
  enableRawMode();
  const config = validateEnv();
  const session = new Session({
    dir: ".omega/sessions",
    maxContextTokens: config.maxContextTokens,
  });
  logger.setLogFile(`.omega/logs/${session.id}.log`);
  logger.info("Omega agent starting", { session: session.id });

  const fullSystemPrompt = SYSTEM_PROMPT + loadProjectContext();

  const haikuAgent = new AgentConfig({
    systemPrompt: fullSystemPrompt,
    model: config.model,
    maxTokens: config.maxTokens,
  });

  haikuAgent
    .addTool(new BashTool())
    .addTool(new GrepTool())
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

  const screen = new Screen();
  const spinner = new Spinner(screen);
  const assistantText = new DisplayAssistantText(screen);
  const toolCallText = new DisplayToolCall(screen);
  const toolResultText = new DisplayToolResult(screen);

  const ctx = new Context({
    session,
    agentConfig: haikuAgent,
    runner,
    screen,
  });

  const lineEditor = new LineEditor();

  while (true) {
    const prompt = new Prompt({
      editor: lineEditor,
      ctx,
      modals: modalCommandsMap,
    });
    const result = await screen.readLine(prompt);

    // Historial: lo tipeado (incluye comandos).
    const typed = lineEditor.getResult();
    if (typed.trim() !== "") {
      lineEditor.addToHistory(typed);
    }

    // Un comando modal (ej: /resume) ya hizo su efecto dentro del Prompt.
    // No ecoamos "> /resume"; solo mostramos la confirmación (si hay) y
    // limpiamos el editor. printAbove("") limpia la lista sin imprimir nada.
    if (result.kind === "modal") {
      lineEditor.reset();
      screen.printAbove(result.message ?? "");
      continue;
    }

    const input = result.text;

    // Eco del input arriba del editor (sin la caja, para que no parezca otro
    // prompt), y limpiamos el buffer (siempre).
    const echo = lineEditor.renderEcho();
    lineEditor.reset();
    screen.printAbove(echo);

    if (await dispatchCommand(input, ctx)) {
      continue;
    }

    if (input === "exit") {
      logger.info("Omega agent stopped");
      // El listener de stdin del Screen mantiene vivo el event loop, así que
      // un break dejaría el proceso colgado. Salimos explícito; el handler de
      // process.on("exit") restaura la raw mode.
      disableRawMode();
      process.exit(0);
    }

    const session = ctx.session;

    const resolvedInput = expandFileMentions(input);
    const userContent: Message["content"] = [];
    if (resolvedInput.text) {
      userContent.push({ type: "text", text: resolvedInput.text });
    }
    for (const img of resolvedInput.images) {
      userContent.push(img);
    }

    // Si solo hay texto, lo pasamos como string simple para mantener
    // compatibilidad con el formato legacy
    const firstItem = userContent[0];
    if (
      userContent.length === 1 &&
      typeof firstItem === "object" &&
      "type" in firstItem &&
      firstItem.type === "text"
    ) {
      session.addUserMessage((firstItem as { type: "text"; text: string }).text);
    } else {
      session.addUserMessage(userContent);
    }

    let iterator: AsyncGenerator<unknown>;
    try {
      iterator = runner.run(session.messages);

      let item = await iterator.next();

      while (!item.done) {
        const { value } = item as { value: RunnerEvent };

        if (value.type === "text_stream") {
          spinner.stop();
          assistantText.displayStream(value.text);
          spinner.start();
        }

        if (value.type === "text_stream_end") {
          assistantText.endStream();
        }

        if (value.type === "text") {
          spinner.stop();
          assistantText.display(value.text);
          spinner.start();
        }

        if (value.type === "tool_use") {
          spinner.stop();
          toolCallText.display(value.name);
        }

        if (value.type === "tool_result") {
          toolResultText.display(value.output);
          spinner.start();
        }

        if (value.type === "state") {
          session.addMessage(value.message);
        }

        item = await iterator.next();
      }
      spinner.stop();
    } catch (err: unknown) {
      // Nos aseguramos de que el spinner se detenga ante cualquier error
      spinner.stop();
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Runner error", msg);
      screen.printAbove(dim(`Error: ${msg}`));
    }

    // Métricas de la iteración
    const metrics = runner.getMetrics();
    session.addUsage(
      metrics.totalInputTokens,
      metrics.totalOutputTokens,
      metrics.totalCost,
    );
    const durationSec = (metrics.durationMs / 1000).toFixed(1);
    const costStr =
      metrics.totalCost < 0.01 ? "<$0.01" : `${metrics.totalCost.toFixed(2)}`;
    const runningStr =
      session.totalCost < 0.01 ? "<$0.01" : `${session.totalCost.toFixed(2)}`;
    const metricsLine = `~ ctx: ${session.contextTokens} tk · ${metrics.totalToolCalls} tools · in: ${metrics.totalInputTokens} · out: ${metrics.totalOutputTokens} tokens · ${durationSec}s · ${costStr} (total: ${runningStr})`;
    screen.printAbove(dim(`\n${metricsLine}`));
    runner.resetMetrics();
  }
};

main().catch((err) => {
  disableRawMode();
  console.log(err);
  logger.error("Fatal error", err);
  process.exit(1);
});
