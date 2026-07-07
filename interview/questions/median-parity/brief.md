`compute("median", input)` (en `index.mjs`) da un resultado incorrecto cuando la
entrada tiene una cantidad **par** de números.

Ejemplo:
- `compute("median", "1 2 3 4")` devuelve `3`, pero debería devolver `2.5`
  (el promedio de los dos valores centrales).

Arreglá el cálculo de la mediana. No cambies las firmas de las funciones.
