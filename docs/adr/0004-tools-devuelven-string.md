# 0004 — Las tools devuelven `string` y nunca lanzan

- **Status:** accepted
- **Date:** 2026-07-04 _(backfill)_
- **Deciders:** Benjamin (+ Claude)

## Contexto

En un loop agéntico, cada tool_use necesita un tool_result que el modelo pueda
leer y sobre el que pueda actuar. Si una tool lanza una excepción sin capturar,
el runner se cae o el modelo se queda sin feedback y frena.

## Decisión

Toda `Tool.execute` **devuelve `string`** (nunca `throw` hacia afuera): los
errores se capturan y se devuelven como texto, marcados con `is_error: true`
para que el runner los pinte en rojo y cuente errores consecutivos. El error es
**información para el modelo**, no una excepción de control de flujo. Los
mensajes de error son accionables (ej. `edit` muestra el bloque más parecido;
`bash` bloqueado explica cómo pedir `force`).

## Consecuencias

- El modelo **siempre** recibe algo sobre lo que iterar; el runner no se cae por
  una tool que falla.
- Habilita la detección de loops por N errores consecutivos en el runner.
- **Costo:** es una convención que hay que recordar en cada tool nueva; el tipo
  `Promise<string>` no distingue "ok" de "error" salvo por el flag que arma el
  runner al capturar.
