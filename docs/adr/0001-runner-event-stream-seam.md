# 0001 — El Runner emite un event stream UI-agnóstico (seam hexagonal)

- **Status:** accepted
- **Date:** 2026-07-04 _(backfill de una decisión temprana)_
- **Deciders:** Benjamin (+ Claude)

## Contexto

Omega arrancó con una TUI, pero el norte es que el mismo core corra en otros
frontends (headless, GitHub, Slack, nube). Si el loop agéntico habla directo
con la terminal (imprime, lee teclas), cada frontend nuevo obliga a reescribir
el loop. La mayoría de los harnesses caseros caen en esta trampa.

## Decisión

El `Runner.run()` es un **async generator que emite `RunnerEvent`**
(`text`, `text_stream`, `tool_use`, `tool_result`, `state`, `ask_user`) — no
sabe nada de la terminal. La TUI (`src/index.ts`) es solo **un consumidor** de
ese stream. La interacción con el humano (ej. `ask_user`) entra por un callback
inyectado (`onAskUser`), no por acceso directo a I/O.

## Consecuencias

- **Habilita** múltiples frontends sin tocar el loop: otro frontend = otro
  consumidor del mismo stream. Es el seam que hace factible el norte de nube.
- El `AbortSignal` que hoy dispara Ctrl+C/Esc es el mismo mecanismo que mañana
  dispara "excediste el budget" en un runner autónomo.
- **Deuda pendiente:** `index.ts` todavía mezcla el consumo del stream con
  orquestación específica de TUI (visión, type-ahead, statusline). Extraer eso
  detrás de un puerto `Frontend` es el "seam refactor" (`docs/design/frontend-architecture-design.md`).
