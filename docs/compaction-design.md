# Compaction/poda dentro del loop — diseño

Issue: #35

## Objetivo

Evitar que el contexto se infle porque el modelo reenvía archivos leídos en turnos anteriores. Dos mecanismos:

**A. Compactación por antigüedad:** reads de más de 3 turnos cuyo contenido tiene >20 líneas se reemplazan por un marcador:
`[leído src/foo.ts hace 5 turnos — 200 líneas omitidas]`

**B. Invalidación por edición:** si un archivo fue editado/write después de ser leído, el read viejo se marca como inválido:
`[src/foo.ts fue editado después — el contenido anterior ya no es válido]`

## Nuevo modelo de datos en Session

```
Session {
  #messages: Message[]          // historial completo (inmutable, para auditoría)
  #workingContext: Message[]    // contexto con compactaciones aplicadas
}
```

- `getContext()` → `pruneContext(workingContext, maxTokens)` — lo que recibe el runner
- `messages` getter → historial completo (antes era `allMessages`)
- `addUserMessage()` / `addMessage()` → agregan a ambos arrays
- `compactWorkingContext()` → aplica `compactStaleReads` sobre `#workingContext`, se llama al final de cada turno
- Se persisten ambos arrays en el JSON

## Algoritmo de compactStaleReads

```
Entrada: messages[], { staleTurns: 3, minLines: 20 }
Salida: nuevo array (no muta la entrada)

Fase 1 - Scan:
  turnNumber = 0
  readRegistry: Map<tool_use_id, { path, turnNumber, lineCount }>
  lastEditTurn: Map<path, turnNumber>

  Para cada mensaje:
    Si es user y NO es tool_result → turnNumber++
    Si es assistant con tool_use "read" → registrar en readRegistry
    Si es assistant con tool_use "edit"/"write" → registrar en lastEditTurn
    Si es user con tool_result de un read → actualizar lineCount

Fase 2 - Compact:
  Para cada mensaje:
    Si es user con tool_results:
      Para cada tool_result:
        Si el read asociado tiene lineCount >= minLines:
          Si lastEditTurn[path] > readTurn → invalidar por edición
          Si age >= staleTurns → compactar por antigüedad
    Mensajes no modificados: misma referencia
    Mensajes modificados: nuevo objeto (shallow clone)
```

## Flujo en index.ts

```
session.addUserMessage(userContent)       // → #messages + #workingContext
iterator = run.run(session.getContext())  // → pruneContext(workingContext)
// ... state events:
session.addMessage(value.message)         // → #messages + #workingContext
// después del loop:
session.compactWorkingContext()           // → compactStaleReads sobre #workingContext
```

## Regeneración

Si se carga una sesión sin `workingContext` (formato viejo), se regenera aplicando `compactStaleReads` sobre `#messages`.