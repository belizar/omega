Agregá un nuevo estadístico `mode` (el valor más frecuente) al evaluador.

Después del cambio, `compute("mode", input)` (en `index.mjs`) tiene que devolver el
número que más veces aparece en la entrada. Ejemplos:
- `compute("mode", "1 2 2 3")` → `2`
- `compute("mode", "5 5 5 1 2")` → `5`

Seguí el patrón de los estadísticos que ya existen (`mean`, `median`). No rompas
los que ya andan.
