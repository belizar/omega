# Proyecto 1 — Dossier (gestor de contexto single-session)

**Estado:** diseño cerrado, listo para bajar a build. El protocolo de emisión,
la taxonomía, el budget/evicción y el event schema están definidos.

**Relación con Proyecto 2 (orquestación multi-sesión):** este proyecto es
independiente y se sostiene solo. El dossier acota el contexto **dentro de una
sola sesión** — no necesita planner, milestones ni orquestador. El Proyecto 2
(ver `multisession-orchestration-design.md`) se apoya encima de éste cuando una
tarea es tan grande que ni la sesión acotada alcanza, o cuando se quieren resets
deliberados de contexto fresco. **P1 ES la degradación graceful de P2:** sin
planner, tenés exactamente este sistema.

---

## 1. Problema

El loop agéntico actual tiene una sola sesión que crece sin techo: en cada step
se reenvía todo el historial, así que el input escala **cuadrático** en los
steps (≈ C·N²/2). Medido con `scripts/context-growth.ts` sobre la sesión real
`classifier`: 270 steps, **18.0M tokens de input**; la compactación bajó la
pendiente ~32% pero no cambió la forma de la curva (1k → 122k por step), y al
tocar el cap aparece **context rot**.

El costo lo abarata el caching de OpenRouter (~90%). El problema real es
**calidad + autonomía**: una sesión de 270 steps razona peor al final, y "cortá
a mano" mata el punto de tener un agente.

**Piezas ya construidas:** `scripts/context-growth.ts` (medición) e
instrumentación per-step `stepUsage` en runner/session (input/output/cached/cost
real por call — la señal de presupuesto en vivo).

---

## 2. Idea central

El dossier es **working memory acotada** que reemplaza/evoluciona el
`workingContext + compactStaleReads` actual. En vez de reenviar todo el
historial compactado mecánicamente, lo que ve el modelo en cada step es:

```
contexto enviado = system + dossier-fold + últimas K turnos crudos
```

- **dossier-fold** = el pasado destilado en entries estructuradas, acotado por
  un budget de tokens.
- **últimas K turnos crudos** = el working set vivo (lo que el modelo está
  reaccionando ahora). K chico (unos pocos turnos).

A medida que un turno envejece más allá de K, su esencia **ya está** en el
dossier (el agente la emitió mientras actuaba, ver §4) y el crudo se descarta.

> **El dossier es lo que `compactStaleReads` quiere ser de grande.** Hoy la
> compactación encoge mecánicamente los reads viejos (lossy, ciego). El dossier
> es compresión **semántica, autoría del agente**: en vez de truncar el read
> viejo, el agente ya emitió un `file`/`decision`/`gotcha` que captura su
> esencia.

El contexto queda acotado por construcción → la rampa se aplana → una **single
session genuinamente long-running** se vuelve viable.

---

## 3. Taxonomía de entries

Cinco tipos. **Mantener el set en cinco** — más tipos = más decisiones de
categorización = fricción y mis-clasificación.

| Tipo | Qué captura | Creación | Stickiness |
|------|-------------|----------|------------|
| `decision` | Elección de approach + el porqué (+ alternativa descartada). El espinazo no-derivable. | Sidecar (en una mutación) o tool `decide`. | **Máxima** — solo muere *superseded* o promovida. |
| `gotcha` | Trampa no-obvia aprendida a los golpes ("tests necesitan Docker"). Scar tissue. | Sidecar (post-error) o tool `note`. | **Muy alta** — o promovida a long-term. |
| `task` | Laburo pendiente. | Sidecar o tool. | **Depende del estado.** |
| `file` | "Toqué X: \<outline\> + edité Y para Z". Puente a re-hidratación. | **Forzada** (rationale de edit/write). | **Media** — no evicta, *comprime*. |
| `observation` | Hecho aprendido explorando. | Sidecar (raro) o barrido en reflexión. | **Mínima** — re-derivable gratis. |

**Ciclo de vida de `task`:** `open → done / dropped`. (El estado `migrated` y
`targetMilestone` solo aplican en Proyecto 2; en single-session no hay "próxima
sesión a la que migrar".)

**Disciplina central: el dossier es un ÍNDICE, no un archivo.** Las entries
guardan nota + punteros (outline, `refs`), nunca el contenido completo de los
archivos. La re-hidratación es on-demand (outline + read + grep).

---

## 4. Protocolo de emisión

**La idea que disuelve el "¿cuándo emitir?": el sidecar.** La emisión no es un
turno aparte — es un *campo* dentro de una tool call que el agente ya hace.
Cuesta cero turnos extra y pasa en el momento de la acción (fidelidad intacta).

**Caminos por tipo:**

- `file` — **forzado.** `edit`/`write` ganan un `rationale` **requerido**
  (string, "qué cambiás y por qué", una línea). Al ejecutar, la tool emite el
  evento `create`/`update` del `file` entry. Si el rationale **falta o está
  vacío**, la tool **rechaza** — mismo patrón BLOCK del clasificador de bash. (NO
  se rechaza por "trivial": juzgar trivialidad necesitaría un juez subjetivo /
  otra call; los racionales perfunctorios se detectan **después** analizando el
  log, no se gatean en vivo.)
- `decision` / `task` / `gotcha` — **sidecar opcional** en `edit`/`write`/`bash`
  (las tools donde estos eventos se agrupan): aceptan `notes?: Note[]`. Decidís
  y editás → la decisión va de sidecar en el edit. Workaround tras un fallo →
  el gotcha va de sidecar en el bash exitoso.
- `observation` — no forzada, casi no se emite (re-derivable); si importa,
  sidecar; si no, la barre la reflexión.
- Nota pura sin acción (raro) — tool dedicada `note`/`decide`. Esta sí cuesta un
  turno; solo para lo que no acompaña ninguna acción.

**La línea forzar-vs-no se traza en la MUTACIÓN.** edit/write/bash-destructivo
fuerzan rationale; exploración (read/grep/ls) no lleva sidecar ni se fuerza
(tools limpias). ~80% cubierto gratis.

**Red de seguridad — reflexión (DIFERIDA a v2).** Una pasada que revisa lo hecho
("¿decisiones o gotchas que no anotaste?") podría rellenar lo que el sidecar no
capturó. Pero es un multiplicador de complejidad (prompt nuevo, trigger nuevo,
flujo nuevo) y el sidecar + rationale forzado ya cubre ~80%. Se **posterga a
v2**: primero medimos qué tan bueno es el sidecar solo con datos reales, recién
después agregamos reflexión si hace falta.

**Patrón de dos notas (nativo):** una emisión puede llevar un `followUp` (string)
→ el runner genera **dos** eventos `create`: la entry primaria (decisión/
observación ahora) y una **segunda entry `task` con `state: open`** cuyo `text`
es el `followUp`, ambas con el **mismo `threadId`**. Así se reconstruye el arco
del tema siguiendo el thread.

**Dónde vive:** las tools, al ejecutar, devuelven sus eventos de dossier además
del resultado normal; el runner los colecta y appendea al log — **el mismo
patrón con que ya colectamos `stepUsage`**.

**Resultado clave:** la emisión **no mueve el schema** (§6). Todo se expresa con
campos de `Entry` que ya existen (`text`, `threadId`, `refs.toolUseId` para
procedencia, `state`). Solo cambian los **schemas de input de las tools**
(rationale requerido, notes opcional, tool note/decide). El schema queda
validado como estable.

---

## 4bis. Formato del fold (serialización para el prompt)

El fold es el *read model* del dossier para el LLM; su formato decide cuánto vale
cada token. Definido (no pendiente):

- **Agrupado por tipo**, y dentro de cada grupo las más recientes primero.
- **Orden de grupos por prioridad:** decisions y gotchas primero (lo
  no-derivable), después open tasks, después files recientes, observations al
  final si entran en el budget.
- **Una línea por entry:** `[decision] <text> (refs: path:line)`. El `text` se
  **aplana a una línea** (newlines → espacio) al serializar.
- El `rationale` se **embebe en el `text`** al serializar (no como campo aparte),
  para que el modelo lo lea como contexto natural. El schema lo mantiene como
  campo separado para análisis; el `fold()` lo aplana al armar el prompt.

---

## 5. Budget + evicción

Sin fricción el agente acumula todo y el dossier se re-infla (para un LLM copiar
es gratis; el filtro de esfuerzo del BuJo humano desaparece).

- **Budget de tokens = techo.** Filtra sobre la moneda real, no un proxy. Da
  techo duro, premia notas concisas. Tokens por entry con chars/4 (ya en el
  script).
- **Truncado-por-step vs evicción (son distintos).** Cada step el `fold()` arma
  el contexto en orden de prioridad y lo **corta al budget**; lo que no entra
  simplemente **no se incluye en ese step pero sigue vivo** (no destructivo). La
  **evicción** es el caso extremo y **destructivo**: retira entries del set vivo
  (pasan a log-only), y se dispara solo cuando ni siquiera los tiers altos
  (decisions + gotchas + open tasks) entran en el budget — ahí corre la escalera.
  O sea: truncar es normal cada step; evictar es la excepción que mantiene el set
  vivo acotado.
- **Escalera de evicción** (qué se va primero):

  ```
  done/dropped tasks (salen por ciclo)
    → observations
    → comprimir files (dropea el outline re-derivable, MANTIENE el rationale/"para qué")
    → open tasks
    → gotchas / decisions
  ```

- **Válvula para las entries pegajosas:** un `gotcha`/`decision` que la escalera
  estaría por evictar **no se pierde** — si es general del proyecto, se
  **promueve** a long-term (§7); si no, se dropea. Así nunca perdés el "por qué".

> La justificación-del-agente como desempate de evicción es una refinación del
> Proyecto 2 (vive en el ritual de migración). En P1 la evicción es automática:
> escalera + LRU dentro del tipo. Más simple, shippeable.

---

## 6. Event log + schema

Event sourcing: **el dossier vivo es un fold sobre un log append-only.** El log
entero **nunca** entra al contexto; solo el fold budgeteado. Logueás todo (en
disco, gratis), inyectás poco (el fold acotado).

```ts
type Op =
  | "create" | "update"            // nacimiento + mutación
  | "complete" | "drop" | "supersede"  // ciclo de vida
  | "compress" | "evict"           // presión de budget (actor:system)
  | "promote"                      // graduación a long-term
  | "task_start" | "session_end";  // lifecycle (entryId nulo)
  // NOTA: "migrate" y "milestone_advance" son del Proyecto 2.

type DossierEvent = {
  seq: number;              // orden monotónico (≈ nro de línea del JSONL)
  ts: string;               // ISO
  taskId: string;
  sessionId: string;        // SIEMPRE — la unidad mecánica (un Runner.run)
  milestone?: number;       // OPCIONAL — vacío en single-session
  actor: "agent" | "system";
  op: Op;
  entryId?: string;         // nulo en lifecycle ops
  mechanism?: "ladder" | "manual";  // por qué un evict/compress (para métricas)
  delta?: Partial<Entry>;   // qué cambió (legibilidad de la mutación)
  snapshot?: Entry;         // estado completo tras aplicar
};

type Entry = {
  id: string;
  type: "decision" | "gotcha" | "task" | "file" | "observation";
  text: string;
  state?: "open" | "done" | "dropped";   // (+ "migrated" en P2)
  threadId?: string;
  refs?: { path?: string; line?: number; toolUseId?: string };
  rationale?: string;        // el "por qué" acoplado a la acción
  tokens?: number;           // peso estimado (chars/4)
};

// Lo que el agente pone en el sidecar `notes?: Note[]` de edit/write/bash.
// (file NO va por acá — va por el `rationale` requerido de la mutación.)
type Note = {
  type: "decision" | "gotcha" | "task" | "observation";
  text: string;
  followUp?: string;   // texto de una task a crear, enlazada por threadId
};
// El runner traduce cada Note en un evento `create`, e inyecta él mismo el
// refs.toolUseId (sabe de qué tool call vino el sidecar) — el agente no lo pasa.
```

**Decisiones del schema:**
- **Delta + snapshot juntos.** Redundante pero las entries son chicas. Premio:
  **dossier vivo actual = último snapshot por `entryId`** (`max(seq) GROUP BY
  entryId`, sin foldear); el fold solo para reconstruir la *historia*.
- **`mechanism` en evict/compress** (catch de omega): distingue evicción
  automática (escalera) de manual, para poder medir "evicciones que se
  re-crean".
- **`milestone`/`targetMilestone` ausentes en single-session** — el mismo schema
  soporta P2 sin tocarse (solo agrega ops).
- **Ops granulares** para que el análisis sea `GROUP BY op` trivial.
- **`actor`** separa conducta del agente vs política del sistema.

**Store:** JSONL = fuente de verdad (`.omega/dossiers/<taskId>.jsonl`, append
puro, cero dep). SQLite = proyección derivada **opcional** (reconstruible del
log). `node:sqlite` anda en Node 22.22 **sin flag** → cero deps externas, sin
binding nativo. Diferible: el log es la verdad, la DB se bolt-onea sin rework.

**Métricas del log (para mejorar omega):** tasa de evicción/re-creación
(mismo `threadId` = budget muy apretado, costo de re-descubrimiento), gotchas
recurrentes (candidatos a long-term), trayectoria de tokens del dossier.

---

## 7. Long-term memory (nivel 3, light)

Tres niveles de memoria: working context (sesión, muere), dossier (tarea), y
**long-term** (proyecto, durable: gotchas + decisiones clave). La **promoción**
gradúa un gotcha/decisión del dossier a long-term cuando es general del proyecto
(al cerrar la tarea, o cuando la escalera estaría por evictarlo — §5).

**v1 sin retrieval:** omega ya inyecta `AGENT.md` entero
(`loadProjectContext`). Long-term v1 = un `AGENT.md` auto-curado por promoción,
inyectado **wholesale**. El margen es **medible** con el mismo chars/4 (cuándo
inyectarlo entero "duele" = cuando come demasiado del budget de contexto).
Retrieval (embeddings/vector) solo cuando el wholesale deje de alcanzar — no
antes.

**Mecanismo de promoción:** el agente emite eventos `promote` durante la sesión
(barato, solo marca "esto es general del proyecto"); un paso **offline al cerrar
la sesión** lee los `promote` y los escribe en `AGENT.md`. Nunca mid-session —
el agente no edita su propio contexto en vuelo.

---

## 8. Orden de build

0. **Baseline / benchmark (milestone 0).** Antes de tocar nada, capturar
   métricas base de 2-3 sesiones reales (tokens/step, curva de `context-growth`,
   y completitud de una tarea canónica) con el harness de
   `benchmarking-design.md`. Sin esto, el "la rampa se aplana" del milestone 3 es
   subjetivo. La calidad de respuesta es parcialmente subjetiva — medí lo
   objetivo (tokens, curva, task-completion) y dejá lo cualitativo aparte.
1. **Núcleo determinístico (milestone 1).** Tipos `Entry`/`DossierEvent`, append
   a JSONL, `fold`, "dossier vivo = último snapshot por entryId", política de
   evicción por budget. **Funciones puras, unit-testeables con eventos
   sintéticos, sin agente vivo** — omega lo construye Y lo prueba solo, sin el
   trap de "compila ≠ funciona". No depende del protocolo de emisión.
2. **Emisión.** `rationale` requerido en edit/write (+ rechazo si falta), sidecar
   `notes` en edit/write/bash, tool `note`/`decide`. Las tools devuelven eventos;
   el runner los colecta.
3. **Cableado en el runner.** Reemplazar `getContext()` para que arme
   `system + fold + últimas K turnos` en vez del workingContext completo.
   Verificación viva (con vos en el loop): correr una sesión larga y mirar con
   `context-growth` que la rampa se aplana.
4. **Long-term (promoción → AGENT.md wholesale).** Último, opcional.

---

## 9. Parámetros y pendientes

**Defaults iniciales** (se calibran en el milestone 0/3 con `context-growth`):

- **K = 4** turnos crudos. Heurística: "los turnos que un humano necesita releer
  para entender qué está pasando ahora". <3 pierde el hilo; >5 el crudo vuelve a
  crecer.
- **Budget del fold ≈ 3K tokens.** Con ~100 tokens por entry bien escrita, da
  ~30 entries vivas — suficiente para decisiones + gotchas + files recientes de
  una sesión larga.

El **formato del fold** ya está definido (§4bis).

**Todavía a decidir:**

- Detección semi-automática de gotchas (tool falla → retry funciona) — ¿v1 o
  después?
- Trigger exacto / umbral de la evicción destructiva (calibración, no
  arquitectura — §5).

---

## 9bis. Riesgos y mitigaciones

- **El agente ignora el dossier** (el riesgo más profundo). Mitigación
  estructural: el fold **reemplaza** la historia cruda — el modelo ya no tiene
  los turnos viejos, el fold es TODO lo que tiene del pasado. No hay historia
  cruda a la que caer, así que no puede ignorarlo volviendo al comportamiento
  viejo. El riesgo se reduce a "¿atiende un fold terso tan bien como turnos
  crudos?" → tuning de formato (§4bis).
- **Deriva semántica al comprimir.** Una `file` comprimida pierde el "para qué".
  Mitigación: la compresión dropea el outline re-derivable pero **mantiene el
  rationale** (§5) — se va lo que el outline tool puede recuperar, se queda lo
  que no.
- **Overhead de emisión.** Si los racionales crecen a párrafos, el costo sube.
  Mitigación: rechazar solo por **vacío** (no por "trivial", §4); los racionales
  gordos/perfunctorios se detectan analizando el log, no gateando en vivo.
- **Mala calibración de budget/K.** Muy chico → evicción agresiva →
  re-descubrimiento; muy grande → vuelve el bloat. Mitigación: el log mide
  evicciones que se re-crean (mismo `threadId`, §6); calibrar en milestone 0/3.
- **Costo de la reflexión.** Disuelto: la reflexión se difiere a v2 (§4).

---

## 10. Qué es irreversible

Solo el **shape del evento (§6)**. Todo lo demás (store, proyecciones, formato
del fold, emisión, long-term) se cambia/bolt-onea después *desde el log*, sin
reescribir. Secuencia sana: clavar el schema, construir el núcleo determinístico,
después emisión, después cableado.
