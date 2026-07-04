# 0008 — Cabinet como memoria de largo plazo (por qué > qué, git-backed)

- **Status:** accepted
- **Date:** 2026-07-04 _(backfill)_
- **Deciders:** Benjamin (+ Claude)

## Contexto

La ventana de contexto es memoria de trabajo efímera: se pierde entre sesiones.
Hay conocimiento durable (decisiones y su porqué, gotchas no obvios, modelos
mentales) que es **costoso de re-derivar** y tiene **vida media larga**, y que
hoy se re-descubre en cada sesión.

## Decisión

Un **cabinet** en disco (`.omega/cabinet` por proyecto + `~/.omega/cabinet`
global), versionado con git. Reglas (`src/cabinet.ts`, `buildCabinetContext`):
- **Compuerta de consolidación:** alto costo de re-derivar × vida media larga =
  consolidá. Conservador: en duda, no.
- **El porqué, no el qué:** nunca snapshotear cosas con fuente de verdad viva
  (el código ya dice qué hace el código).
- **INDEX eager** (punteros, no contenido); los docs se leen bajo demanda.

## Consecuencias

- Conocimiento que trasciende sesiones sin inflar cada contexto (recall
  selectivo vía el INDEX).
- **Riesgo:** un cabinet ruidoso es peor que uno chico y verdadero — por eso la
  compuerta es deliberadamente conservadora.
- Resuelto por git-common-dir para compartirse entre worktrees.
- **Pendiente** (no decidido aún, es diseño): modo sueño/housekeeping, tier
  global maduro, workspaces multi-agente. Ver `docs/design/memory-system-design.md`.
