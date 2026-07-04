# 0002 — Un solo core como SDK, sin forks

- **Status:** accepted
- **Date:** 2026-07-04 _(backfill)_
- **Deciders:** Benjamin (+ Claude)

## Contexto

Con la herramienta personal (TUI local) y el producto de nube para Medra
apuntando al mismo motor, la tentación es forkear: copiar el core y adaptarlo.
Ya se sufrió el dolor de portar el mismo fix dos veces entre ramas/copias.

## Decisión

**Un solo core (SDK).** La TUI local y "Omega para Medra (Cloud)" son
**composiciones** del mismo core con distintos adapters — misma sangre, distinto
cuerpo. Nada de forks: el core se extiende una vez, los productos son apps
encima. (Ver `docs/design/frontend-architecture-design.md` y `omega-for-medra.md`.)

## Consecuencias

- **Habilita** arreglar/mejorar una vez y que todos los productos lo hereden.
- **Obliga** a mantener el core genérico y libre de supuestos de un frontend
  particular — disciplina de diseño, no gratis.
- Depende de [ADR-0001](0001-runner-event-stream-seam.md): sin el seam
  UI-agnóstico, "un solo core" sería una aspiración, no una realidad.
