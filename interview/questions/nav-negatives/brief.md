`compute(kind, input)` (en `index.mjs`) devuelve resultados incorrectos cuando la
entrada contiene números negativos.

Por ejemplo:
- `compute("median", "-5 -3 -1")` devuelve `3`, pero debería devolver `-3`.
- `compute("mean", "-2 -4")` devuelve `3`, pero debería devolver `-3`.

Los casos con números positivos funcionan bien. Encontrá la causa raíz y arreglala.
No cambies las firmas de las funciones.
