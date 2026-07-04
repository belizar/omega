# 0005 — Poda de contexto turn-aware + compactación de reads rancios

- **Status:** accepted
- **Date:** 2026-07-04 _(backfill)_
- **Deciders:** Benjamin (+ Claude)

## Contexto

Las tareas agénticas generan decenas de pasos internos por turno de usuario. El
contexto crece hasta reventar la ventana del modelo. Truncar de forma naive
rompe el formato: un `tool_use` sin su `tool_result` (o un `assistant` al inicio
de la ventana) hace que el provider rechace la request.

## Decisión

Dos mecanismos, en `src/context-management.ts`:
1. **`pruneContext` turn-aware:** recorta desde lo más viejo por presupuesto de
   tokens, pero **nunca** corta en medio de un par `tool_use`/`tool_result` ni
   deja un `assistant` como primer mensaje de la ventana.
2. **`compactStaleReads`:** reemplaza reads viejos (por antigüedad en pasos) o
   invalidados (el archivo se editó después) por un marcador; el agente re-lee
   si necesita. Corre en cada paso del loop, antes de podar.

Estimación de tokens deliberadamente **sobre**estimada (~3 chars/token) y un
**cap absoluto por tool_result** (12k tokens) para que un dump gigante no
expulse la conversación.

## Consecuencias

- Sesiones largas estables sin romper el formato del provider.
- Sobreestimar tokens = podar de más, no de menos (dirección segura).
- **Costo:** los marcadores de compactación obligan a re-lecturas ocasionales
  (visibles en las métricas anti-thrashing del runner). La estimación no es
  exacta; es un colchón, no una medición.
