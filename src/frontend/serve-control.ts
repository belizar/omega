import { DaemonClient } from "./daemon-client.js";
import { readDaemonInfo, clearDaemonInfo, isAlive, DaemonInfo } from "./daemon-info.js";

/** Uptime legible: "3m", "2h 5m", "45s". */
function uptime(startedAt: number): string {
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** El puerto a probar: el del registro (si hay) manda sobre el default del CLI. */
function targetPort(info: DaemonInfo | null, fallback: number): number {
  return info?.port ?? fallback;
}

/**
 * `omega serve status`: ¿hay un daemon corriendo? Combina el registro (pidfile)
 * con la verdad (ping al puerto + pid vivo), y avisa si quedó algo inconsistente
 * (un pidfile stale, o un proceso vivo que no responde).
 */
export async function serveStatus(fallbackPort: number): Promise<void> {
  const info = readDaemonInfo();
  const port = targetPort(info, fallbackPort);
  const client = new DaemonClient(port);
  const up = await client.ping();

  if (!up) {
    process.stdout.write("  Ω daemon: apagado\n");
    if (info && isAlive(info.pid)) {
      // Proceso vivo pero mudo: crasheó a medias, o está trabado. No lo matamos
      // solos — se lo decimos al humano con el comando exacto.
      process.stdout.write(
        `  ⚠ hay un proceso (pid ${info.pid}) que NO responde en :${info.port}\n` +
          `    matalo con: kill ${info.pid}\n`,
      );
    } else if (info) {
      // Registro stale (el daemon murió sin limpiar): lo barremos de una.
      clearDaemonInfo();
    }
    return;
  }

  const { sessions } = await client.sessions();
  const live = sessions.filter((s) => s.live).length;
  process.stdout.write("  Ω daemon: corriendo\n");
  if (info) {
    process.stdout.write(`    pid ${info.pid} · :${info.port} · up ${uptime(info.startedAt)}\n`);
    process.stdout.write(`    cwd ${info.cwd}\n`);
    process.stdout.write(`    bin ${info.bin}\n`);
  } else {
    process.stdout.write(`    :${port} (sin registro — daemon viejo, sin daemon.json)\n`);
  }
  process.stdout.write(`    ${sessions.length} sesiones · ${live} vivas\n`);
}

/**
 * `omega serve stop`: para el daemon con SIGTERM → dispara su shutdown ORDENADO
 * (duerme las sesiones, NO destruye workspaces ni transcripts). Espera a que muera
 * de verdad y limpia el registro.
 */
export async function serveStop(fallbackPort: number): Promise<void> {
  const info = readDaemonInfo();
  const port = targetPort(info, fallbackPort);
  const client = new DaemonClient(port);
  const up = await client.ping();

  if (!up && !(info && isAlive(info.pid))) {
    process.stdout.write("  Ω daemon: ya estaba apagado\n");
    clearDaemonInfo();
    return;
  }

  const pid = info?.pid;
  if (!pid) {
    // Corriendo pero sin registro (daemon pre-lifecycle): no sabemos el pid.
    process.stdout.write(
      `  ✗ el daemon responde en :${port} pero no tengo su pid (sin daemon.json)\n` +
        `    matalo con: lsof -ti:${port} | xargs kill\n`,
    );
    return;
  }

  // SIGTERM = el shutdown handler del daemon (disposeAll + clearDaemonInfo).
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* justo se murió: seguimos al chequeo de abajo */
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (!isAlive(pid)) break;
  }

  if (isAlive(pid)) {
    process.stdout.write(
      `  ⚠ el daemon (pid ${pid}) no murió con SIGTERM en 5s; forzalo: kill -9 ${pid}\n`,
    );
    return;
  }

  clearDaemonInfo();
  process.stdout.write(
    `  Ω daemon parado (pid ${pid}). Las sesiones quedaron dormidas — revivibles al reiniciar.\n`,
  );
}
