// Los prebuilds de node-pty traen un `spawn-helper` (unix) que se ejecuta al
// spawnear un PTY. Al extraer el paquete, npm a veces le pierde el bit ejecutable
// → `posix_spawnp failed` en RUNTIME (no en install), un error críptico. Este
// postinstall le devuelve el +x. No-op en Windows (usa conpty, sin helper).
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const prebuilds = join(process.cwd(), "node_modules", "node-pty", "prebuilds");
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, dir, "spawn-helper");
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755);
      } catch {
        /* best-effort: si no podemos, node-pty lo reportará al spawnear */
      }
    }
  }
}
