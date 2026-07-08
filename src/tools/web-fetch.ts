import { lookup } from "dns/promises";
import { Tool } from "./tool.js";
import { logger } from "../logger.js";

type WebFetchInput = { url: string };

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 5_000_000; // tope de descarga (5MB) — no nos comemos una página gigante
const MAX_OUTPUT_CHARS = 30_000; // tope de salida al modelo (~7-8k tokens)

/**
 * Trae una URL de la web y devuelve su contenido como texto legible. Nativa
 * (usa el `fetch` global de node, sin dependencias) — el agente ya podía `curl`
 * por bash, pero esta tool da salida limpia (HTML→texto, no HTML crudo que quema
 * contexto), funciona aunque el bash esté con la red aislada, y trae una guarda
 * SSRF (no llega a la red interna / metadata de la nube). invoker=modelo,
 * source=builtin.
 */
export class WebFetchTool extends Tool<WebFetchInput, string> {
  constructor() {
    super({
      name: "web_fetch",
      description:
        "Trae una URL de la web y devuelve su contenido como texto legible " +
        "(HTML → texto sin tags). Usala para leer documentación, artículos, " +
        "páginas, issues/PRs de GitHub, etc. — cualquier URL http(s) que te " +
        "pase el usuario o que encuentres. Solo internet público: no accede a " +
        "la red interna ni a localhost.",
      schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "La URL http(s) a traer." },
        },
        required: ["url"],
      },
    });
  }

  async execute(input: WebFetchInput, signal?: AbortSignal): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch {
      return `Error: URL inválida: ${input.url}`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `Error: solo se permiten URLs http(s) (recibí "${parsed.protocol}").`;
    }

    // Guarda SSRF: resolvemos el hostname y chequeamos la IP real contra rangos
    // privados/loopback/link-local (incluye la metadata de la nube 169.254.169.254).
    // Resolver, no solo mirar el literal, atrapa un hostname que apunte adentro.
    const blocked = await this.#ssrfCheck(parsed.hostname);
    if (blocked) return `Error: acceso bloqueado a "${parsed.hostname}" (${blocked}). web_fetch solo llega a internet público.`;

    // Timeout propio + la señal del runner (Ctrl+C) combinadas.
    const signals = [AbortSignal.timeout(TIMEOUT_MS)];
    if (signal) signals.push(signal);

    let res: Response;
    try {
      res = await fetch(parsed.href, {
        redirect: "follow",
        signal: AbortSignal.any(signals),
        headers: {
          "User-Agent": "omega-agent/1.0 (+https://github.com/belizar/omega)",
          Accept: "text/html,text/plain,application/json,application/xhtml+xml,*/*",
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timed out") || msg.includes("aborted")) {
        return `Error: la request a ${parsed.href} se pasó del timeout (${TIMEOUT_MS / 1000}s) o fue cancelada.`;
      }
      return `Error al traer ${parsed.href}: ${msg}`;
    }

    if (!res.ok) {
      return `Error HTTP ${res.status} ${res.statusText} al traer ${parsed.href}.`;
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();

    // Rechazá binarios antes de bajarlos: no hay nada legible que devolver.
    if (!/text\/|json|xml|javascript|\+xml|application\/x-|^\s*$/.test(contentType) && contentType !== "") {
      return `No puedo renderizar el contenido de ${parsed.href} (content-type: ${contentType || "desconocido"}). Es binario o no-texto.`;
    }

    const body = await this.#readCapped(res);
    if (body === null) {
      return `Error: no se pudo leer el cuerpo de ${parsed.href}.`;
    }

    const isHtml = /text\/html|application\/xhtml/.test(contentType);
    let text = isHtml ? htmlToText(body) : body;
    text = text.trim();

    let note = "";
    if (text.length > MAX_OUTPUT_CHARS) {
      note = `\n\n[…truncado: mostrando ${MAX_OUTPUT_CHARS} de ${text.length} caracteres]`;
      text = text.slice(0, MAX_OUTPUT_CHARS);
    }

    logger.info("web_fetch", { url: parsed.href, status: res.status, bytes: body.length, html: isHtml });

    const finalUrl = res.url && res.url !== parsed.href ? ` (redirigido a ${res.url})` : "";
    return `Fetched: ${parsed.href}${finalUrl}\nContent-Type: ${contentType || "?"}\n\n${text}${note}`;
  }

  /** Lee el body con tope de bytes (aunque no venga content-length). */
  async #readCapped(res: Response): Promise<string | null> {
    const lenHeader = res.headers.get("content-length");
    if (lenHeader && Number(lenHeader) > MAX_BYTES) {
      return `[La página pesa ${lenHeader} bytes, más del tope de ${MAX_BYTES}. No se bajó.]`;
    }
    if (!res.body) {
      try {
        return (await res.text()).slice(0, MAX_BYTES);
      } catch {
        return null;
      }
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          chunks.push(value);
          if (total >= MAX_BYTES) break;
        }
      }
    } catch {
      return null;
    }
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c.subarray(0, Math.min(c.length, buf.length - off)), off);
      off += c.length;
      if (off >= buf.length) break;
    }
    return new TextDecoder("utf-8").decode(buf);
  }

  /** Devuelve la razón del bloqueo, o null si la IP resuelta es pública. */
  async #ssrfCheck(hostname: string): Promise<string | null> {
    const host = hostname.replace(/^\[|\]$/g, ""); // IPv6 entre corchetes
    if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
    let ip = host;
    if (!isIpLiteral(host)) {
      try {
        ip = (await lookup(host)).address;
      } catch {
        return "no se pudo resolver el hostname";
      }
    }
    if (isPrivateIp(ip)) return "IP privada/loopback/link-local";
    return null;
  }
}

function isIpLiteral(s: string): boolean {
  return /^[0-9.]+$/.test(s) || s.includes(":");
}

/** Chequeo de rangos privados/loopback/link-local para IPv4 e IPv6 (básico). */
function isPrivateIp(ip: string): boolean {
  // IPv6
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) return true; // link-local + unique-local
    // IPv4-mapped (::ffff:a.b.c.d)
    const m = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  // IPv4
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // raro → bloquear
  const [a, b] = p;
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + metadata de la nube
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** HTML → texto legible, casero (sin deps). Saca ruido, mapea bloques a saltos
 *  de línea, decodifica entidades comunes, colapsa espacios. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1>/gi, " ");
  // Bloques que terminan → salto de línea (para no pegar todo en una sola línea).
  s = s
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|blockquote|pre|ul|ol|table)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<[^>]+>/g, " "); // resto de tags
  s = decodeEntities(s);
  return s
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™",
    laquo: "«", raquo: "»", deg: "°", eacute: "é", aacute: "á", iacute: "í",
    oacute: "ó", uacute: "ú", ntilde: "ñ", Ntilde: "Ñ",
  };
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const cp = code[1] === "x" || code[1] === "X"
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return named[code] ?? named[code.toLowerCase()] ?? m;
  });
}
