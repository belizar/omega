import { randomBytes } from "crypto";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ── Magic bytes de formatos de imagen ────────────────────────────────────────

const MAGIC: Array<{ bytes: number[]; ext: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], ext: "png" },        // PNG
  { bytes: [0xff, 0xd8, 0xff], ext: "jpg" },               // JPEG
  { bytes: [0x47, 0x49, 0x46, 0x38], ext: "gif" },         // GIF
  { bytes: [0x52, 0x49, 0x46, 0x46], ext: "webp" },        // WebP
  { bytes: [0x42, 0x4d], ext: "bmp" },                     // BMP
];

const TMP_DIR = join(homedir(), ".omega", "tmp");

/** Detecta formato de imagen por magic bytes. */
export function detectImageFormat(buf: Buffer): string | null {
  for (const { bytes, ext } of MAGIC) {
    if (buf.length < bytes.length) continue;
    let match = true;
    for (let i = 0; i < bytes.length; i++) {
      if (buf[i] !== bytes[i]) { match = false; break; }
    }
    if (!match) continue;
    if (ext === "webp" && buf.length >= 12) {
      if (buf.toString("ascii", 8, 12) !== "WEBP") continue;
    }
    return ext;
  }
  return null;
}

/**
 * Intenta leer una imagen del portapapeles del sistema.
 * macOS: prueba PNG, luego TIFF (lo convierte con sips), luego JPEG.
 * Linux: xclip.
 * Devuelve { data, ext } o null.
 */
export function readClipboardImage(): { data: Buffer; ext: string } | null {
  try {
    if (process.platform === "darwin") {
      return readClipboardMacOS();
    }
    if (process.platform === "linux") {
      return readClipboardLinux();
    }
    return null;
  } catch {
    return null;
  }
}

function readClipboardMacOS(): { data: Buffer; ext: string } | null {
  mkdirSync(TMP_DIR, { recursive: true });

  // Estrategia: probar formatos en orden de preferencia.
  // Cada intento devuelve hex string o "".
  // PNG es el más común para screenshots.
  // TIFF es lo que ponen apps como Preview/Finder para imágenes no-PNG.
  // JPEG es fallback universal.

  const attempts = [
    { class: "PNGf",  regex: /«data PNGf([0-9A-Fa-f\s]+)»/ },
    { class: "TIFF",  regex: /«data TIFF([0-9A-Fa-f\s]+)»/ },
    { class: "JPEG",  regex: /«data JPEG([0-9A-Fa-f\s]+)»/ },
  ];

  for (const { class: cls, regex } of attempts) {
    let hexMatch: RegExpExecArray | null = null;

    try {
      const out = execSync(
        `osascript -e 'try' -e 'get the clipboard as «class ${cls}»' -e 'end try'`,
        { encoding: "buffer", timeout: 3000 },
      );
      hexMatch = regex.exec(out.toString("utf-8"));
    } catch {
      continue;
    }

    if (!hexMatch) continue;

    const hexStr = hexMatch[1].replace(/\s/g, "");
    const data = Buffer.from(hexStr, "hex");
    const format = detectImageFormat(data);

    // Si ya es PNG o JPEG, devolver directo
    if (format === "png" || format === "jpg") {
      return { data, ext: format };
    }

    // TIFF: convertir a PNG con sips
    if (cls === "TIFF") {
      const tiffPath = join(TMP_DIR, `clip-tiff-${randomBytes(4).toString("hex")}.tiff`);
      const pngPath = tiffPath.replace(/\.tiff$/, ".png");
      writeFileSync(tiffPath, data);

      try {
        execSync(`sips -s format png "${tiffPath}" --out "${pngPath}"`, { timeout: 5000 });
        const pngData = readFileSync(pngPath);
        // Limpiar temp files
        try { unlinkSync(tiffPath); } catch { /* ok */ }
        try { unlinkSync(pngPath); } catch { /* ok */ }
        return { data: pngData, ext: "png" };
      } catch {
        try { unlinkSync(tiffPath); } catch { /* ok */ }
        continue;
      }
    }
  }

  return null;
}

function readClipboardLinux(): { data: Buffer; ext: string } | null {
  const data = execSync("xclip -selection clipboard -t image/png -o 2>/dev/null", {
    encoding: "buffer",
    timeout: 3000,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (data.length > 0) {
    return { data, ext: "png" };
  }
  return null;
}

/** Guarda datos de imagen en .omega/tmp/img-{random}.{ext}. */
export function saveTempImage(data: Buffer, ext: string): string {
  const rand = randomBytes(6).toString("hex");
  const filename = `img-${rand}.${ext}`;
  mkdirSync(TMP_DIR, { recursive: true });
  const fullPath = join(TMP_DIR, filename);
  writeFileSync(fullPath, data);
  return fullPath;
}