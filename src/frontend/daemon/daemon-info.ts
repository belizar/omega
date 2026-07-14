import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/**
 * El "registro de sí mismo" del daemon: quién es (pid), dónde escucha (port),
 * desde qué cwd/dist corre. Es lo que le permite al CLI (`omega serve stop/status`)
 * encontrar al proceso que él mismo lanzó detached — sin esto no habría forma de
 * pararlo prolijo (había que `lsof -ti:PORT | xargs kill`).
 *
 * OJO: es un CACHE, no la verdad. Si el daemon crashea sin limpiarlo, queda stale.
 * Por eso todo lector VALIDA con `isAlive(pid)` + un ping al puerto antes de creerle.
 */
export interface DaemonInfo {
  pid: number;
  port: number;
  /** cwd de arranque (el baseDir que hospeda las sesiones "compartidas"). */
  cwd: string;
  /** Desde qué dist corre (`process.argv[1]`). Sirve para ver el bug del
   *  "dead-dist": un daemon sirviendo un build de un worktree ya borrado. */
  bin: string;
  startedAt: number;
}

export const DEFAULT_DAEMON_INFO_PATH = join(homedir(), ".omega", "daemon.json");

export function writeDaemonInfo(info: DaemonInfo, path = DEFAULT_DAEMON_INFO_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(info, null, 2), "utf-8");
}

export function readDaemonInfo(path = DEFAULT_DAEMON_INFO_PATH): DaemonInfo | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw?.pid === "number" && typeof raw?.port === "number") return raw as DaemonInfo;
  } catch {
    /* no existe o está corrupto */
  }
  return null;
}

export function clearDaemonInfo(path = DEFAULT_DAEMON_INFO_PATH): void {
  try {
    unlinkSync(path);
  } catch {
    /* ya no estaba */
  }
}

/**
 * ¿El proceso sigue vivo? `process.kill(pid, 0)` NO manda señal — solo chequea si
 * el pid existe. Lanza ESRCH si no existe, EPERM si existe pero es de otro usuario
 * (para nosotros: existe igual).
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
