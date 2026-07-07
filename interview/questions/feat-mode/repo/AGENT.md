# Stats evaluator

Un evaluador de estadísticos sobre una lista de números pasada como string.

## Estructura

- `tokenize.mjs` — `tokenize(input)`: parte el string en tokens.
- `parse.mjs` — `parse(input)`: convierte el input en `number[]` (usa `tokenize`).
- `stats.mjs` — los estadísticos, cada uno recibe `nums: number[]`: `mean`, `median`.
- `index.mjs` — `compute(kind, input)`: parsea el input y **despacha** al
  estadístico según `kind` (un `switch`).

## Cómo agregar un estadístico nuevo

1. Escribí la función en `stats.mjs` (recibe `nums: number[]`, devuelve un número).
2. Registrá un `case "<kind>"` en el `switch` de `compute()` en `index.mjs` que la
   llame.

No hace falta tocar `tokenize.mjs` ni `parse.mjs` para un estadístico nuevo.
