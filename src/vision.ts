import { writeFileSync, readFileSync, unlinkSync, readdirSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { logger } from "./logger.js";
import type { ImageMessage } from "./message.js";
import { Tool } from "./tools/tool.js";

// ── Constantes ───────────────────────────────────────────────────────────────

const TMP_DIR = join(homedir(), ".omega", "tmp");

/** Guarda los bytes de una imagen como temp file. Devuelve el path absoluto. */
function saveImage(data: string, ext: string): string {
  const rand = randomBytes(6).toString("hex");
  const filename = `vision-${rand}.${ext}`;
  mkdirSync(TMP_DIR, { recursive: true });
  const fullPath = join(TMP_DIR, filename);
  writeFileSync(fullPath, Buffer.from(data, "base64"));
  return fullPath;
}

// ── Limpieza de temp files viejos (al iniciar omega, best-effort) ────────────

export function cleanOldVisionTemps(): void {
  try {
    const files = readdirSync(TMP_DIR);
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    let cleaned = 0;

    for (const f of files) {
      if (!f.startsWith("vision-")) continue;
      try {
        const fullPath = join(TMP_DIR, f);
        const st = statSync(fullPath);
        if (now - st.mtimeMs > ONE_HOUR) {
          unlinkSync(fullPath);
          cleaned++;
        }
      } catch {
        // best-effort
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned ${cleaned} old vision temp files`);
    }
  } catch {
    // Dir no existe: ok
  }
}

// ── Preprocesador: descripción inicial desde VISION_MODEL ────────────────────

export interface PreprocessResult {
  description: string;
  savedPaths: string[];
  savedImages: Array<{ ext: string; data: string }>;
}

export async function preprocessImages(
  userContent: Array<Record<string, unknown>>,
  visionModel: string | null,
  visionMaxTokens: number,
  openrouterApiKey: string,
): Promise<PreprocessResult> {
  const imageBlocks = userContent.filter(
    (b) => b.type === "image" && typeof (b as ImageMessage).source === "object",
  ) as ImageMessage[];

  if (imageBlocks.length === 0) {
    return { description: "", savedPaths: [], savedImages: [] };
  }

  const savedPaths: string[] = [];
  const savedImages: Array<{ ext: string; data: string }> = [];

  for (const img of imageBlocks) {
    const src = img.source;
    if (src.type !== "base64") continue;
    const mediaType = src.media_type ?? "image/png";
    const ext = mediaType.split("/")[1] ?? "png";
    const data = src.data;
    const path = saveImage(data, ext);
    savedPaths.push(path);
    savedImages.push({ ext, data });
  }

  if (!visionModel) {
    const placeholder =
      imageBlocks.length === 1
        ? "[Se pegó una imagen, pero VISION_MODEL no está configurado — no puedo verla.]"
        : `[Se pegaron ${imageBlocks.length} imágenes, pero VISION_MODEL no está configurado — no puedo verlas.]`;
    return { description: placeholder, savedPaths, savedImages };
  }

  try {
    const description = await callVisionModel(
      visionModel,
      visionMaxTokens,
      openrouterApiKey,
      imageBlocks,
    );
    const tagged =
      `[Descripción preliminar de la imagen, por modelo de visión — puede ser incompleta. ` +
      `Usá la tool vision_ask para verificar detalles específicos.]\n\n${description}`;
    return { description: tagged, savedPaths, savedImages };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Vision preprocess failed", { error: msg });
    const placeholder =
      `[Imagen pegada, pero el modelo de visión falló: ${msg}. ` +
      `Podés intentar vision_ask para reintentar.]`;
    return { description: placeholder, savedPaths, savedImages };
  }
}

export function cleanupTurnTemps(paths: string[]): void {
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      // best-effort
    }
  }
}

// ── vision_ask tool ──────────────────────────────────────────────────────────

type VisionAskInput = { question: string };

export class VisionAskTool extends Tool<VisionAskInput, string> {
  #visionModel: string;
  #visionMaxTokens: number;
  #apiKey: string;
  #sessionImages: ImageMessage[] = [];

  constructor(visionModel: string, visionMaxTokens: number, apiKey: string) {
    super({
      name: "vision_ask",
      description:
        "Hacele una pregunta específica al modelo de visión sobre las imágenes " +
        "pegadas en esta sesión. Usala cuando necesites verificar detalles " +
        "que la descripción preliminar no cubrió: leer texto exacto, identificar " +
        "números, confirmar colores o elementos visuales. " +
        "IMPORTANTE: hacé todas tus preguntas en una sola llamada (batchealas). " +
        "No llames vision_ask múltiples veces por pequeñas dudas — juntalas.",
      schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "Pregunta específica sobre la(s) imagen(es). Sé preciso: " +
              '"¿qué dice exactamente el mensaje de error en la línea 42?" en vez de ' +
              '"¿qué hay en la imagen?".',
          },
        },
        required: ["question"],
      },
    });
    this.#visionModel = visionModel;
    this.#visionMaxTokens = visionMaxTokens;
    this.#apiKey = apiKey;
  }

  addImages(images: ImageMessage[]): void {
    this.#sessionImages.push(...images);
  }

  clearImages(): void {
    this.#sessionImages = [];
  }

  async execute(input: VisionAskInput): Promise<string> {
    if (this.#sessionImages.length === 0) {
      return "Error: no hay imágenes en esta sesión. Pegá una imagen con Ctrl+V primero.";
    }

    try {
      return await callVisionModel(
        this.#visionModel,
        this.#visionMaxTokens,
        this.#apiKey,
        this.#sessionImages,
        input.question,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error al consultar el modelo de visión: ${msg}. Probá de nuevo o continuá con la información disponible.`;
    }
  }
}

// ── Llamada HTTP al modelo de visión (OpenRouter) ─────────────────────────────

async function callVisionModel(
  model: string,
  maxTokens: number,
  apiKey: string,
  images: ImageMessage[],
  prompt?: string,
): Promise<string> {
  const content: Array<Record<string, unknown>> = [];

  const textPrompt =
    prompt ??
    "Describí esta imagen en detalle. Sé preciso: transcribí texto literal, " +
    "nombres de archivos, números de línea, mensajes de error, tipos, nombres " +
    "de variables y funciones. No interpretes — describí lo que ves.";

  let finalText = textPrompt;
  if (images.length > 1 && !prompt) {
    finalText +=
      `\n\nHay ${images.length} imágenes. Describilas una por una, ` +
      `etiquetando cada una como "Imagen 1", "Imagen 2", etc.`;
  }
  content.push({ type: "text", text: finalText });

  for (const img of images) {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${img.source.media_type ?? "image/png"};base64,${img.source.data}`,
      },
    });
  }

  const body = {
    model,
    messages: [{ role: "user", content }],
    max_tokens: maxTokens,
    temperature: 0,
  };

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`Vision model HTTP ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = json.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("Vision model returned empty response");
  }

  return text;
}