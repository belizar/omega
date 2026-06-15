# Diseño del LineEditor y render.ts

## 1. Modelo de datos: buffer + cursor

El estado del editor son dos valores: un string (`#buffer`) y un índice (`#cursor`). No hay posición x/y guardada, se calcula cuando hace falta.

```
#buffer = "hola\nmundo"
#cursor = 7        // entre la 'u' y la 'n' de "mundo"
```

Todas las operaciones son aritmética de strings:

- **Insertar**: `buffer.slice(0, cursor) + text + buffer.slice(cursor)`, después `cursor += text.length`.
- **Backspace**: `buffer.slice(0, cursor-1) + buffer.slice(cursor)`, después `cursor--`.
- **Delete**: `buffer.slice(0, cursor) + buffer.slice(cursor+1)` (cursor no cambia).
- **Mover cursor**: solo `cursor++` o `cursor--`, validando bordes.

## 2. Geometría de líneas

Como el buffer puede tener `\n`, hay helpers para traducir índice de carácter a fila/columna y viceversa:

- `#lineStart()` busca el `\n` anterior al cursor para saber dónde empieza la línea actual.
- `#lineEnd()` busca el `\n` siguiente al cursor.
- `#cursorLine()` y `#cursorCol()` convierten el índice a (fila, columna).
- `#moveToPrevLine()` y `#moveToNextLine()` arrancan en el `\n` de la línea vecina y colocan el cursor en la columna correcta (truncada si la línea destino es más corta).

Esto permite que Up/Down en multilínea preserve la columna siempre que se pueda.

## 3. Historial con draft

El historial es un array `#history` de strings. La navegación funciona así:

- `#historyIndex = -1` significa "no estoy navegando, estoy en el buffer real".
- Cuando se aprieta Up por primera vez, se guarda el buffer actual en `#draftBuffer` y `#draftCursor`, se pone `#historyIndex` en el último comando, y se reemplaza el buffer.
- Up sucesivo decrece `#historyIndex` (comandos más viejos).
- Down sube `#historyIndex`. Cuando llega al final, restaura el draft (lo que estabas escribiendo antes de navegar).

`addToHistory()` evita duplicados consecutivos.

## 4. Multilínea + historial sin conflicto

La regla: Up/Down primero mueven entre líneas. Solo si el cursor está en la primera línea (Up) o última línea (Down) del buffer, pasan a navegar el historial. Esto se chequea en `#handleUp()` y `#handleDown()` comparando `#cursorLine()` con `#lineCount()`.

## 5. Atajos de teclado

| Atajo   | Acción                                |
|---------|---------------------------------------|
| Ctrl+A  | Ir al inicio de línea (Home)          |
| Ctrl+E  | Ir al final de línea (End)            |
| Ctrl+U  | Borrar desde inicio de línea hasta cursor |
| Ctrl+K  | Borrar desde cursor hasta fin de línea    |
| Ctrl+W  | Borrar palabra hacia atrás                |

Implementados en `#handleCtrl()` usando `#deleteRange(from, to)`.

## 6. Render con cursor ANSI real

`render()` devuelve `"> " + buffer`.

`getCursorPosition()` devuelve `{ row, col }` donde `row` es la línea del cursor (0-based) y `col` es la columna visual, sumando los 2 caracteres del prompt `"> "` solo si es la primera línea.

`render.ts` usa esto para posicionar el cursor del terminal con secuencias ANSI:

```
\x1b[0J     borrar de acá hacia abajo
\x1b[{n}A   subir n líneas
\x1b[{n}C   avanzar n columnas
```

El ciclo de dibujo:

1. Dibujar el render completo al stdout.
2. El cursor del terminal queda al final del render. Se calcula cuántas líneas subir y cuántas columnas avanzar para llegar a la posición indicada por `getCursorPosition()`.
3. Se emiten los códigos ANSI que mueven el cursor a esa posición.

## 7. El bug del output pisado — save/restore cursor

**Problema**: `\x1b[{n}A` es un movimiento relativo. Entre cada iteración del loop principal de `index.ts`, el cursor queda al final del output del asistente. La segunda iteración hacía `\x1b[2A` desde ahí creyendo que llegaba al editor, pero el editor estaba muchas líneas más arriba. El `\x1b[0J` borraba líneas del historial de output.

**Solución**: `\x1b7` (DECSC) guarda la posición absoluta del cursor justo antes del primer `draw()`. Cada `draw()` posterior empieza con `\x1b8` (DECRC) que restaura esa posición exacta, sin importar qué pasó entre medio. Es un ancla fija.

Al hacer commit, el cursor se baja al final del contenido del editor con `\x1b[{n}B` y se emite `\r\n` para que el siguiente output del loop principal quede debajo, no encimado.

## 8. `reset()` e instancia única

`LineEditor` se instancia una sola vez en `index.ts` (antes del `while`). `run()` lo usa, y al terminar se llama `reset()` que limpia buffer y done pero conserva el historial. Sin esto, el segundo `run()` veía `#done = true` y terminaba al instante sin esperar input.

## 9. `InputComponent` y el contrato

La interfaz `InputComponent<T>` en `component.ts` define el contrato entre el componente y `render.ts`:

```ts
interface InputComponent<T> {
  render(): string;
  handleKey(key: Key): void;
  isDone(): boolean;
  getResult(): T;
  getCursorPosition?(): CursorPosition;
}
```

`getCursorPosition()` es opcional — si no está, `render.ts` no intenta posicionar el cursor y simplemente lo deja al final del output.

## 10. `decodeKey.ts`

Convierte bytes crudos del stdin en eventos tipados (`Key`). Soporta:

- Caracteres imprimibles, enter, backspace, tab, escape
- Flechas (up/down/left/right), home, end, delete
- Ctrl+letra (bytes 0x01-0x1a)
- Pegado con bracketed paste (`\x1b[200~`)
- Shift+Enter (`\x1b[27;2;13~`)

Esto abstrae completamente las secuencias de escape del resto del sistema.
