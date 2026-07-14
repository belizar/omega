import { Context } from "../../app-context.js";
import { loadCustomCommands } from "../../commands/custom.js";
import { modalCommandsMap } from "../../commands/index.js";
import { CoreServices } from "../../core.js";
import { logger } from "../../logger.js";
import { Message } from "../../message.js";
import { TurnRunner } from "../../turn-runner.js";
import { preprocessImages, cleanupTurnTemps } from "../../tools/vision-ask.js";
import {
  DisplayAssistantText,
  DisplayToolCall,
  DisplayToolResult,
} from "../../tui/components/display-text.js";
import { LineEditor } from "../../tui/components/line-editor.js";
import { Spinner } from "../../tui/components/spinner.js";
import { expandFileMentions } from "../../tui/file-mentions.js";
import { collectHeroInfo } from "../../tui/hero.js";
import { AnsiRenderer } from "../../tui/markdown/ansi-renderer.js";
import { Screen } from "../../tui/screen.js";
import { TUIFrontend } from "../frontends/tui-frontend.js";
import type { FrontendMode } from "./mode.js";

/**
 * Modo TUI: el frontend interactivo de terminal. Monta Screen + las piezas de
 * render y corre el loop de prompt (input → turno → repetir). Es el driver por
 * defecto — el que corrés cuando ejecutás `omega` sin `-p`.
 */
export class TuiMode implements FrontendMode {
  #core: CoreServices;

  constructor(core: CoreServices) {
    this.#core = core;
  }

  async run(): Promise<void> {
    const { config, session, agentConfig, toolRegistry, classifier, visionAskTool } = this.#core;

    const heroInfo = collectHeroInfo({
      profile: session.profile,
      model: config.model,
      visionModel: config.visionModel,
      toolCount: 9, // read, write, edit, bash, grep, outline, tool_search, ask_user, web_fetch
    });

    const screen = new Screen(config.screenPadding);
    const spinner = new Spinner(screen);
    // El renderer capea las tablas al mismo ancho al que printAbove re-envuelve
    // (paddingRight + indent), si no las tablas anchas se re-parten y se rompen.
    // indent de Screen = 2 (su default; ver el constructor de Screen).
    const assistantText = new DisplayAssistantText(screen, new AnsiRenderer(config.screenPadding + 2));
    const toolCallText = new DisplayToolCall(screen);
    const toolResultText = new DisplayToolResult(screen);

    // Slash commands custom del usuario (.omega/commands/*.md, proyecto + global).
    const customCommands = loadCustomCommands();

    const ctx = new Context({ session, agentConfig, screen, toolRegistry, classifier, customCommands });
    const lineEditor = new LineEditor();

    // Puerto de entrada (seam). Envuelve las instancias de TUI; el core (loop)
    // habla con esta interfaz, no con screen/spinner/lineEditor directamente.
    const frontend = new TUIFrontend({
      screen,
      spinner,
      assistantText,
      toolCallText,
      toolResultText,
      lineEditor,
      ctx,
      modals: modalCommandsMap,
      heroInfo,
      getVerbose: () => ctx.verbose,
    });

    const turnRunner = new TurnRunner(this.#core, ctx, frontend);

    // Modelo de visión efectivo por turno (override de /model ?? perfil).
    const resolveVisionModel = (): string | null =>
      ctx.session.modelOverrides.vision ?? config.visionModel;

    frontend.start();

    while (true) {
      // El type-ahead (mensajes encolados mientras el agente trabajaba) lo drena
      // el propio frontend dentro de nextInput().
      const inp = await frontend.nextInput();

      if (inp.kind === "exit") {
        logger.info("Omega agent stopped");
        // El listener de stdin del Screen mantiene vivo el event loop, así que
        // un break dejaría el proceso colgado. Salimos explícito; el handler de
        // process.on("exit") restaura la raw mode.
        frontend.stop();
        process.exit(0);
      }

      // Comando slash o modal ya resuelto por el frontend. Si un modal dejó un
      // runner pendiente (ej: /resume), lo corremos; si no, seguimos al prompt.
      if (inp.kind === "none") {
        if (ctx.session.pendingRunner) {
          ctx.session.consumePendingRunner();
          await turnRunner.run();
        }
        continue;
      }

      const session = ctx.session;

      const resolvedInput = await expandFileMentions(inp.text);
      const userContent: Message["content"] = [];
      if (resolvedInput.text) {
        userContent.push({ type: "text", text: resolvedInput.text });
      }
      for (const img of resolvedInput.images) {
        userContent.push(img);
      }

      // Imágenes pegadas con Ctrl+V (no procesadas por expandFileMentions)
      const pendingImages = inp.pastedImages;
      for (const img of pendingImages) {
        userContent.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.ext === "png" ? "image/png" :
                        img.ext === "jpg" || img.ext === "jpeg" ? "image/jpeg" :
                        img.ext === "gif" ? "image/gif" :
                        img.ext === "webp" ? "image/webp" :
                        `image/${img.ext}`,
            data: img.data.toString("base64"),
          },
        });
      }

      // Nada que mandar (ej. un encolado que expandió a vacío): saltamos el turno.
      if (userContent.length === 0) continue;

      // ── Preprocesador de visión ──────────────────────────────────────────────
      const hasImages = userContent.some(
        (b) => typeof b === "object" && "type" in b && b.type === "image",
      );
      let turnTempPaths: string[] = [];

      // Modelo de visión efectivo para este turno (override de /model ?? perfil).
      const turnVisionModel = resolveVisionModel();
      if (visionAskTool && turnVisionModel) {
        visionAskTool.setModel(turnVisionModel);
      }

      if (hasImages && turnVisionModel) {
        const visionResult = await preprocessImages(
          userContent as Record<string, unknown>[],
          turnVisionModel,
          config.visionMaxTokens,
          config.openrouterApiKey,
        );
        turnTempPaths = visionResult.savedPaths;

        // Inyectar descripción preliminar al inicio
        if (visionResult.description) {
          userContent.unshift({ type: "text", text: visionResult.description });
        }

        // Acumular imágenes en vision_ask para que las pueda reenviar
        // en turnos futuros (no solo el actual).
        // IMPORTANTE: debe hacerse ANTES de quitar las imágenes de userContent.
        if (visionAskTool && visionResult.savedImages.length > 0) {
          // Las imágenes todavía están en userContent — las capturamos ahora
          const imgBlocks = userContent.filter(
            (b) => typeof b === "object" && "type" in b && b.type === "image",
          ) as unknown as import("../../message.js").ImageMessage[];
          visionAskTool.addImages(imgBlocks);
        }

        // Remover los bloques de imagen del userContent — el modelo principal
        // (ej: DeepSeek) no es multimodal y crashearía con un 404.
        // Las imágenes ya fueron descrita por VISION_MODEL y vision_ask
        // puede reenviarlas si el agente necesita más detalle.
        for (let i = userContent.length - 1; i >= 0; i--) {
          const b = userContent[i];
          if (typeof b === "object" && "type" in b && b.type === "image") {
            userContent.splice(i, 1);
          }
        }
      } else if (hasImages) {
        // Sin VISION_MODEL: placeholder de degradación
        userContent.unshift({
          type: "text",
          text: "[Imagen pegada — VISION_MODEL no configurado. No puedo ver la imagen.]",
        });
      }
      // ──────────────────────────────────────────────────────────────────────────

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

      // ── Runner ──
      await turnRunner.run();

      // Limpiar temp files de visión del turno
      cleanupTurnTemps(turnTempPaths);
    }
  }
}
