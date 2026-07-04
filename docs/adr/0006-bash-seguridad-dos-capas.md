# 0006 — Seguridad de bash en dos capas (hardblock + clasificador)

- **Status:** accepted
- **Date:** 2026-07-04 _(backfill)_
- **Deciders:** Benjamin (+ Claude)

## Contexto

El agente ejecuta comandos bash. Una whitelist/blacklist sola es rígida y
frena el trabajo normal (git, npm, mkdir…). Un clasificador LLM solo no es
confiable para daño **irreversible** (puede fallar en detectar un `rm -rf` o un
`dd` a un disco).

## Decisión

Dos capas en `src/tools/bash.ts` + `src/classifier/`:
1. **Hardblock determinista:** regex de comandos catastróficos (`rm -rf`, fork
   bomb, escritura a `/dev`, `mkfs`, shutdown…) que **nunca** se ejecutan salvo
   `force: true` tras confirmación explícita del usuario.
2. **Clasificador LLM barato** (Haiku vía OpenRouter) para lo ambiguo, con
   **overrides aprendidos** por el usuario y una **whitelist** de comandos
   read-only que saltea el clasificador para bajar latencia.

## Consecuencias

- Defensa en profundidad: el hardblock ataja lo irreversible aunque el
  clasificador falle; el clasificador da flexibilidad donde la lista fija sería
  torpe.
- **Costo / tradeoff explícito:** el clasificador hace **fail-open** tras 3
  fallos de red consecutivos (prioriza no bloquear el trabajo si OpenRouter se
  cae). El hardblock sigue activo, pero comandos ambiguos-peligrosos podrían
  pasar en ese estado.
- **Hueco conocido:** el guard de `.env` es a nivel de tools de archivo; `bash`
  puede leer secretos (`cat .env`, `printenv`). Ver issue de "env-guard en bash".
