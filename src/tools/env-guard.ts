import { basename } from "path";

/**
 * Bloquea archivos .env y sus variantes (.env.local, .env.production, etc.)
 * para que el agente no pueda leer ni escribir secretos.
 */
export function isEnvFile(path: string): boolean {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.") || name === ".envrc";
}

export const ENV_BLOCK_MESSAGE = "Acceso bloqueado: los archivos .env contienen secretos y no pueden leerse ni modificarse.";