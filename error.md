# Bug: duplicación visual en editor multilínea con Shift+Enter

## Síntoma

Al insertar un salto de línea en el editor (Shift+Enter), el render se corrompe: el contenido se duplica o se superpone al anterior.

## Causa raíz

`src/tui/render.ts`, función `draw()`:

```ts
stdout.write(out.replace(/\n/g, "\r\n"));  // ANTES
```

En modo raw, cada `\r` reinicia la columna a 0. Eso descuadra el tracking de `getCursorPosition()`, que cuenta columnas asumiendo que cada `\n` es un salto simple sin modificar la columna. Al descuadrarse la columna, `\x1b8` (DECRC) restauraba a una coordenada incorrecta y `\x1b[0J` limpiaba desde ahí, dejando restos del frame anterior visibles (el efecto "duplicación").

## Fix

Quitar el `\r` del output del render:

```ts
stdout.write(out);  // AHORA: solo \n, sin \r
```

El `\r` solo se usa al posicionar el cursor explícitamente (`\r\x1b[{n}C`), donde sí es necesario para anclar la columna 0 antes de avanzar.

## Archivos modificados

- `src/tui/render.ts`: línea `stdout.write(out.replace(/\n/g, "\r\n"))` → `stdout.write(out)`.

## Fecha

2025-01-XX
