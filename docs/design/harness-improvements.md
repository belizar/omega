# Harness improvements — más calidad con el mismo modelo

Mejoras de andamiaje que suben la calidad de cada sesión **sin cambiar de modelo**.
La tesis: las debilidades de una sesión agéntica casi nunca son falta de inteligencia
del modelo — son del harness. Un modelo capaz con mal harness se ve tonto; un modelo
barato con buen harness se ve capaz.

Evidencia base: la sesión que hizo #11 (SIGINT) + #10 (ask_user). Entregó la feature
y compila, pero: **2,97M tokens de input** para 46k de output, **35 edits** (11 a un
solo archivo), errores de "text not found", un blip de degradación (un edit basura a
`theme.ts` con content `"true"` en contexto largo), y cerró con "compila + tests
pasan" sin verificar el comportamiento real. Todo eso es harness-fixable.

Ordenado por impacto / esfuerzo. Cada item es autocontenido para pasárselo a omega.

---

## 1. Compaction / poda dentro del loop + descartar archivos ya usados

**Problema (evidencia):** leyó 25 archivos y los reenvió enteros en cada paso → el
contexto se infló a ~3M tokens, y un modelo en contexto gigante se distrae, se vuelve
lossy y empieza a producir garbage (el `theme.ts "true"`). El blip de degradación y
el costo son el MISMO problema: contexto sucio y enorme.

**Fix:**
- Poda dentro del loop agéntico, no solo entre turnos (es el P1 del `REVIEW-FIXES.md`).
- Más importante: **descartar el contenido de un archivo del contexto una vez que ya
  se editó o ya se usó.** Reemplazar el resultado de un `read` viejo por un marcador
  tipo `[leído src/runner.ts antes — 200 líneas omitidas]` cuando ya no es el foco.
- Opcional: compaction — cuando el contexto pasa un umbral, resumir los turnos viejos
  en un bloque corto y seguir.

**Por qué sube la calidad:** un contexto chico y filoso hace que el mismo modelo se
comporte como uno más inteligente, degrade menos, y de paso cueste mucho menos.

**Esfuerzo:** medio. **Impacto:** el más alto.

---

## 2. Tool `apply-patch` / multi-edit + mejor feedback de error

**Problema (evidencia):** 35 edits, 11 a `runner.ts`, y varios "Error: Text to
replace not found". El `edit` exige match exacto; si falla, el modelo re-lee el
archivo entero y reintenta → más pasos, más tokens, más thrashing.

**Fix:**
- Una tool que aplique **varios edits a un archivo en una sola llamada** (apply-patch
  estilo diff, o un array de `{oldText, newText}`). El modelo planifica los cambios y
  los aplica de una, en vez de N pokes.
- **Mejor error cuando el `old_string` no matchea:** devolver el match más cercano
  ("¿quisiste decir esto? línea 42: ..."). Así corrige en un tiro en vez de re-leer
  todo el archivo.
- Considerar edits por rango de líneas además de por texto exacto.

**Por qué sube la calidad:** menos pasos, menos re-lecturas, menos errores que
arrastran contexto. Ataca directo el patrón "editar a tientas".

**Esfuerzo:** medio. **Impacto:** alto.

---

## 3. Plan → aprobar → ejecutar (usar el modo plan que YA construiste)

**Problema (evidencia):** el modelo planificó bien al principio, pero después derivó
a pokes incrementales (el thrashing del punto 2).

**Fix:** para tareas grandes, que omega tire el **set completo de cambios** primero,
vos apruebes, y *recién ahí* ejecute en chunks deliberados. La pieza ya existe: el
`ask_user` / modo plan de #10. Falta cablearlo como flujo por defecto en tareas no
triviales (detectar "esto toca varios archivos" → arrancar en plan).

**Por qué sube la calidad:** un plan aprobado convierte 11 edits a tientas en pocos
cambios pensados. Y te da el control que vos querías ("leo los diffs aparte").

**Esfuerzo:** bajo (la tool ya está). **Impacto:** medio-alto.

---

## 4. Verificación dentro de la definición de "terminado" (system prompt)

**Problema (evidencia):** cerró con "compila + 206 tests pasan". Pero SIGINT y
ask_user son **interactivos**: ningún test unitario prueba que Ctrl+C aborta de
verdad ni que ask_user pausa. "Compila" ≠ "anda".

**Fix:** es prompting. Agregar al system prompt algo como: *"Typecheck y tests son
necesarios pero no suficientes. Para cambios de comportamiento (sobre todo
interactivos), escribí un plan de prueba manual de 2-3 pasos y pedíselo al usuario
con `ask_user` antes de declarar la tarea terminada."*

**Por qué sube la calidad:** el mismo modelo, con la instrucción correcta, distingue
"compila" de "se comporta" y no te entrega hipótesis disfrazadas de hechos.

**Esfuerzo:** trivial (texto). **Impacto:** medio, pero te ahorra bugs que pasan el
typecheck.

---

## 5. Scope chico + checkpoints (commit + `/clear` por tarea)

**Problema (evidencia):** metió #11 + #10 en una sola sesión → contexto larguísimo →
degradación. Dos features no triviales en un solo hilo es pedir lío.

**Fix:** un issue por sesión. Al terminar cada uno: **commitear** y **`/clear`** antes
del siguiente, para arrancar con contexto limpio. El harness puede empujarlo (sugerir
checkpoint tras cada tarea cerrada).

**Por qué sube la calidad:** cada sesión arranca filosa en vez de arrastrar el lastre
de la anterior. Bocados chicos, mismo modelo, mejor resultado.

**Esfuerzo:** bajo (hábito + un nudge). **Impacto:** medio.

---

## Cómo medir si funciona

Para saber si estas mejoras realmente suben la calidad (en vez de suponerlo —
acordate del debugging por instrumentación), trackeá por sesión:

- **edits por archivo** (¿bajó el thrashing?)
- **re-lecturas del mismo archivo** (¿el contexto se mantiene útil?)
- **tokens de input totales** (¿bajó el reenvío?)
- **errores de tool** (¿menos "text not found"?)

Ya tenés casi todo en los logs de sesión. Un script que saque estas métricas de un
`.omega/sessions/*.json` te deja comparar antes/después de cada mejora.

---

## Orden sugerido para pasarle a omega

1. **#1 (compaction/poda + descartar archivos)** — el de mayor impacto.
2. **#2 (apply-patch + mejor error de edit)** — mata el thrashing.
3. **#4 (verificación en el system prompt)** — trivial, hacelo ya.
4. **#3 (plan por defecto)** — la tool ya existe, solo cablear.
5. **#5 (scope + checkpoints)** — hábito tuyo más que código.

Los #1 y #2 solos te cambian la calidad de cada sesión futura con el mismo DeepSeek,
y de paso te cortan el costo.
