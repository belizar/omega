# Diseño: rótulos semánticos de sesión (telemetría)

> Problema: en `/telemetry` ves plata y tokens pero sin *meaning*. Las sesiones
> sin nombre manual aparecen como "(sin nombre)" — costo sin historia. Queremos
> un rótulo semántico que diga **de qué fue** cada sesión.

## Decisión central: cuándo se genera

La pregunta difícil no es *cómo* resumir (un modelo barato lo hace), es **cuándo**,
porque el contenido es **efímero** (los worktrees se borran, las sesiones
envejecen) y hay que resumir *mientras el contenido existe*, sin que dependa de
que el humano se acuerde de nada.

**Trigger elegido: tras el primer intercambio completo de la sesión.**

Los primeros turnos ya identifican la **intención** de la sesión. Resumir ahí:

- El contenido **seguro existe** (se acaba de escribir) → sin riesgo de ventana
  perdida, sin hook de exit frágil, sin red de contención en startup.
- Es **automático** — cero memoria del humano, cero "acordate de abrir
  /telemetry".
- Es **barato y acotado** — una sola llamada Haiku por sesión, temprano.

Alternativas descartadas y por qué:

| Trigger | Por qué no |
|---------|-----------|
| En cada `#save` | Una llamada por mensaje. Carísimo. |
| Al final de cada turno | Sesiones de 250+ turnos → 250 llamadas. |
| Al "cerrar la sesión" | En un REPL no hay fin limpio; el hook de exit es frágil. |
| Lazy al abrir `/telemetry` | Depende de que el humano lo abra; para entonces el worktree puede estar borrado → ventana perdida. |
| Al dejar la sesión (transición) | Funciona, pero más infra (tracking de transiciones + exit + startup) que resumir temprano, sin ventaja: temprano ya captura la intención. |

## La salvedad: intención vs. arco

Los primeros turnos capturan la **intención** (qué te propusiste), no siempre el
**arco final** (en qué terminó). Las sesiones driftean: una que arranca "poné la
PR al día con main" puede terminar siendo 8 archivos de otra cosa.

Se acepta conscientemente: la intención es un **anclaje** suficiente para
reubicarse ("ah, esa fue la que arranqué para la PR") y es infinitamente mejor
que "(sin nombre)". No necesitamos el arco perfecto, necesitamos *meaning*.

**Refresh condicional (opcional, para el drift):** si la sesión crece mucho
respecto de cuando se resumió (ej. ≥5x los turnos), se regenera **una sola vez
más**. Automático, tope de 1-2 regeneraciones, sin hooks de exit. Captura las que
se volvieron algo más grande; ignora las focalizadas. Se puede dejar para una
segunda iteración.

## Qué se le da al modelo

Un **digest barato**, no el transcript entero (una sesión puede ser de 22M
tokens — resumirla completa sería absurdo). El digest son **los mensajes del
humano** (los primeros, y en el refresh también los últimos): son los que
definen el arco de intención, y son una fracción mínima de los tokens. Ventaja
extra: el rótulo refleja lo que *pediste*, no lo que el agente respondió.

Salida esperada: un one-liner de ~5-9 palabras. Ejemplos:

- `"Pone esta PR al día con main"` → `Persistir unsupported_media + burbuja UI + deploy`
- `"Mira los últimos cambios de omega"` → `Review de omega + fix de /model y turnos vacíos`

## Dónde se guarda

Un campo `summary` en el **registro de telemetría** (`~/.omega/telemetry/<repo>/<id>.json`),
que hoy solo tiene costo/tokens/modelo/cwd. Se persiste junto con el resto en
`Session.#save` (o en el mismo punto donde se llama `recordTelemetry`). Cacheado:
una vez generado, no se regenera (salvo el refresh condicional).

Prioridad de display en `/telemetry`: `name` (manual) → `summary` (auto) →
`"(sin nombre)"`.

## Sesiones que ya existen (backfill)

Las que ya están registradas no pasaron por el trigger del primer turno. Backfill
**de una sola vez**, mientras sus worktrees siguen vivos: al arrancar (o en el
primer `/telemetry`), para cada sesión sin `summary` cuyo archivo siga
alcanzable vía su `cwd`, generar el rótulo desde su digest. Las de worktrees
borrados se quedan en "(sin nombre)" con gracia.

## Costo

- Régimen normal: 1 llamada Haiku por sesión, al primer intercambio. ~$0.001.
- Backfill inicial: un burst chico (ej. 6 sesiones → ~$0.006).
- Refresh condicional: a lo sumo 1-2 llamadas extra por sesión que driftee.

Insignificante, y **solo se paga cuando hay contenido nuevo que resumir**, nunca
en cada save/turno.

## Roadmap

1. Campo `summary` en `TelemetryRecord` + display en `/telemetry`.
2. Trigger tras el primer intercambio (en el REPL / `runTurn`), digest de mensajes
   del humano, llamada Haiku, persistir en el registro.
3. Backfill único de las sesiones existentes alcanzables.
4. (Opcional) refresh condicional por crecimiento (≥5x turnos).
