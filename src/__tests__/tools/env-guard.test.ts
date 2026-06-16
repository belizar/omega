import { describe, it, expect } from "vitest";
import { isEnvFile } from "../../tools/env-guard.js";

describe("isEnvFile", () => {
  const shouldBlock = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.staging",
    ".envrc",
    "/abs/path/.env",
    "/abs/path/.env.production",
    "project/.env",
  ];

  for (const path of shouldBlock) {
    it(`bloquea ${path}`, () => {
      expect(isEnvFile(path)).toBe(true);
    });
  }

  const shouldAllow = [
    "env.ts",
    "config.ts",
    ".envelope.md",
    ".env-template",
    ".envelope",
    ".environment",
    "readme.env-notes.md",
    "src/env-helper.ts",
    "src/providers/llm-provider.ts",
    "",
    "random-file.txt",
  ];

  for (const path of shouldAllow) {
    it(`permite ${path || "(vacío)"}`, () => {
      expect(isEnvFile(path)).toBe(false);
    });
  }
});

// Los ENV_ACCESS_PATTERNS de bash son un guardarraíl best-effort.
// Esta table documenta honestamente qué patrones atrapan y cuáles no:
//
// Comandos BLOQUEADOS (el patrón matchea):
//   cat .env                ✓
//   cat /path/.env          ✓
//   head .env.local         ✓
//   cp .env .env.bak        ✓
//   mv .env /tmp/           ✓
//   grep FOO .env           ✓
//   echo foo > .env        ✓ (matchea por > .env)
//   tee .env                ✓
//
// Comandos NO BLOQUEADOS (whack-a-mole evadible, no es borde de seguridad):
//   cat .e"nv              ✗ (quote injection)
//   cat .e''nv             ✗
//   xxd .env               ✗ (hex dump)
//   python -c "open('.env')" ✗
//   source .env             ✗
//   node -e "require('fs').readFileSync('.env')"  ✗
//   printenv               ✗ (vuelca claves del process, no necesita .env)
//   node -e "console.log(process.env)"  ✗
//
// Conclusión: el guard frena accidentes y curiosidades casuales,
// pero no frena una prompt-injection decidida. El borde de seguridad real
// sería no cargar los secretos en el process.env del agente.
