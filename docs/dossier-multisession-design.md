# Dossier + Orquestación Multi-Sesión — Diseño

**Estado:** borrador de diseño. Captura las decisiones de la sesión de diseño.
El protocolo de emisión de entries y el retrieval de long-term memory quedan
pendientes (ver §10).

---

## 1. Problema

El loop agéntico actual tiene **una sola sesión** que crece sin techo. En cada
step se reenvía todo el historial acumulado, así que el input total escala de
forma **cuadrática** en los steps: N steps × contexto que crece ≈ C·N²/2.

Medido sobre la sesión real `classifier` con `scripts/context-growth.ts`:

- 270 steps de assistant, **18.0M tokens de input** facturados.
- Sin compactar habría sido 27.0M; la compactación bajó la pendiente ~32% pero
  **no cambió la forma**: el contexto por step sigue siendo una rampa que sube
  (1k → 122k). Compaction es un parche, no la cura.
- Al tocar el cap (~100k) el costo se aplana pero aparece **context rot**: el
  modelo razona peor arrastrando 100k de cosas mayormente viejas.

El problema real no es el costo (el caching de OpenRouter ya lo abarata ~90%):
es **calidad + autonomía**. Una sesión de 270 steps produce peor trabajo al
final que al principio, y "cortá sesiones a mano" tira por la borda el punto de
tener un agente.

**Piezas previas ya construidas:**
- `scripts/context-growth.ts` — mide/grafica el crecimiento del contexto (la
  medición).
- Instrumentación per-step (`stepUsage` en runner/session) — el dato real de
  input/output/cached/cost por call (la señal de presupuesto en vivo).

El dossier es la **cura** de lo que esas dos piezas exponen.

---

## 2. Idea central

Una tarea larga se descompone en **work-sessions acotadas**, cada una con
contexto **fresco**, conectadas por un artefacto destilado: el **dossier**.

Mapeo a primitivas existentes de omega:

- `Runner.run(context)` (loop hasta `end_turn`/`maxSteps`) = una **work-session**.
- Multi-session = un **orquestador** encima que corre `Runner.run()` varias
  veces, cada corrida con contexto = `system + plan + dossier + subtask actual`,
  en vez del `#messages` acumulado.

El efecto: el costo deja de ser cuadrático en *steps totales* y pasa a ser
lineal en el trabajo (cada sesión paga solo su contexto acotado + el dossier,
que crece sub-lineal). Y se cura el rot: el modelo siempre razona en una
ventana chica y limpia.

> La cabeza humana ya trabaja así: editás un archivo, te quedás con la nota
> "toqué X para Y", y **descartás** el contenido. Si lo necesitás, lo volvés a
> abrir. El loop naive hoy **acumula**; el objetivo es que **anote**.

---

## 3. Arquitectura — tres capas

**Planner** — una call que descompone la tarea en hitos ordenados. Cada hito:
objetivo + criterio de aceptación (`compila + pasa test X`) + archivos
probables. Es el espinazo persistente. **No** se le pide "¿cuántas sesiones?"
(se lo inventa) — se le piden hitos, y las sesiones caen de ahí.

**Executor** — por cada hito, un `Runner.run()` con contexto fresco, corriendo
hasta cumplir el criterio o agotar un budget de steps/tokens (medible con la
instrumentación `stepUsage`).

**Distiller** — entre fronteras, produce/actualiza el dossier. **No es resumir
el transcript** (lossy, alucina): es un **ritual de migración** (ver §4).

---

## 4. El dossier (modelo Bullet Journal)

El dossier es **working memory de la tarea**, estructurado como un Bullet
Journal. El BuJo aporta tres mecanismos exactos:

1. **Signifiers = tipos de nota.** Cada entry tiene tipo, no es texto libre
   (ver taxonomía, §5).
2. **Migración + threading = el patrón de dos notas.** Una decisión que implica
   trabajo futuro genera dos entries enlazadas: una *observación* en el hito
   actual ("bug está en X, lo encontré explorando Y") y una *task migrada* en el
   hito destino ("> arreglar bug en X"), con un `threadId` compartido. Se
   reconstruye el arco de un tema siguiendo punteros, **sin arrastrar el
   transcript**.
3. **Migración como ritual, no como resumen.** En el borde, el agente revisa
   cada entry y decide: ¿sigue viva? Si sí, migra (`>`); si no, muere. Es
   estructurado y casi determinístico, no una destilación que alucina.

**Disciplina central: el dossier es un ÍNDICE, no un archivo.** Las entries
guardan la nota + punteros (outline, refs), **nunca el contenido completo** de
los archivos. La re-hidratación es on-demand (outline + read + grep). Si metés
contenido completo, recreás el bloat que querías matar.

---

## 5. Taxonomía de entries

Cinco tipos. **Mantener el set en cinco** — más tipos = más decisiones de
categorización para el agente = fricción y mis-clasificación.

| Tipo | Qué captura | Creación | Stickiness |
|------|-------------|----------|------------|
| `decision` | Elección de approach + el porqué (+ alternativa descartada). El espinazo no-derivable. | Acoplada (`rationale` de edit/write) o emisión. | **Máxima** — solo muere *superseded*. |
| `gotcha` | Trampa no-obvia aprendida a los golpes ("tests necesitan Docker", "no squashear el release PR"). Scar tissue. | Emisión, típicamente post-error (candidata a auto-detección: tool falla → retry funciona). | **Muy alta.** |
| `task` | Laburo pendiente. La unidad migrable. | Emisión. | **Depende del estado** (ver abajo). |
| `file` | "Toqué X: \<outline\> + edité Y para Z". Puente a la re-hidratación. | Acoplada (obligatoria en edit/write). | **Media** — no evicta, *comprime*. |
| `observation` | Hecho aprendido explorando ("el auth check está en middleware.ts"). | Emisión o reflexión. | **Mínima** — re-derivable gratis. |

**Ciclo de vida de `task`:** `open → done / migrated(>) / dropped(~)`.
open/migrated son pegajosas (inbox del hito futuro); done/dropped salen del
dossier vivo al toque (quedan en el log).

**Escalera de evicción** (cuando el budget de tokens se llena, qué se va
primero):

```
done/dropped tasks (salen por ciclo)
  → observations
  → comprimir files (outline → referencia pelada)
  → open/migrated tasks
  → gotchas / decisions
```

La justificación-desempate (§6) entra **solo en los dos últimos escalones**: si
el budget obliga a evictar algo pegajoso, ahí el agente defiende qué sobrevive.
En los primeros se va lo barato solo, sin gastar razonamiento.

---

## 6. Fricción: budget de tokens + justificación

Sin fricción el agente migra todo y el dossier se re-infla (para un LLM copiar
es gratis; el filtro de "esfuerzo" del BuJo humano desaparece). Decisión:

- **Budget de tokens = techo.** Filtra sobre la moneda real (no un proxy como
  cantidad de entries). Da techo duro, premia notas concisas, se adapta, y se
  calibra con datos reales del `context-growth`. Estimación de tokens por entry
  con chars/4 (ya implementado en el script).
- **Justificación = desempate.** Cuando se excede el budget y hay que evictar
  algo pegajoso, el agente justifica qué sobrevive. Razonamiento aplicado en el
  punto de presión, **no** sobre todo (ahí es gratis y no filtra).

**Alternativas descartadas:**
- *Budget de cantidad de entries*: burdo (no se adapta), gameable (mete varias
  cosas en una entry). Es la versión cruda del budget de tokens.
- *Justificación en TODO*: para un LLM justificar es gratis → siente fricción
  pero filtra poco, y no da techo de tamaño.

Los **tipos** son la señal de prioridad sobre la que monta la fricción (la
escalera de §5). Sin tipos, la fricción es ciega.

**Dos momentos de fricción distintos:**
- `migrate` = ritual de **borde**. El agente elige qué cruza y **justifica**
  cada uno (`actor: agent`).
- `evict` = presión de budget **mid-session**. El sistema tira la entry más
  barata según la escalera, **sin** justificación (`actor: system`, es el
  perdedor).

---

## 7. Niveles de memoria

Tres niveles, no dos:

1. **Working context** (dentro de una sesión) — muere cada sesión. Territorio de
   compaction.
2. **Dossier** (dentro de una tarea, cruza sus sesiones) — las entries BuJo,
   budget-bounded, muere al terminar la tarea.
3. **Long-term memory** (cruza TODAS las tareas, scope proyecto) — durable:
   gotchas y decisiones clave. Vive para siempre.

**Promoción:** un gotcha o decisión nace en el dossier (nivel 2); al cerrar la
tarea, si es general del proyecto (no específico de esa tarea), se **promueve**
al nivel 3. Es un `op: promote` en el **mismo** event stream, alimentando otra
proyección.

**El agujero a evitar — retrieval.** Long-term memory que crece arrastra el
problema de "¿cuáles memorias son relevantes para una tarea nueva?". No se
pueden inyectar todas (vuelve el bloat). Ahí está la tentación de
embeddings/vector store/RAG — un subsistema más grande que el dossier entero.

**v1 pragmática:** omega ya inyecta `AGENT.md` entero (`loadProjectContext`).
Long-term memory v1 = un `AGENT.md` auto-curado por promoción, inyectado
**wholesale**, cero retrieval. Cuando crezca tanto que inyectarlo entero duela,
**ahí** —y solo ahí— se mete retrieval.

---

## 8. Event log / persistencia

Event sourcing: **el dossier vivo es un fold sobre un log append-only de
eventos.** El log entero **nunca** entra al contexto; solo el fold budgeteado.
Esto reconcilia "loguear todo para mejorar omega" con "no re-inflar el
contexto": **logueás todo (en disco, gratis), inyectás poco (el fold acotado).**

### Shape del evento (lo único irreversible del diseño)

```ts
type Op =
  | "create" | "update"                            // nacimiento + mutación
  | "migrate" | "complete" | "drop" | "supersede"  // ciclo de vida
  | "compress" | "evict"                           // presión de budget (system)
  | "promote"                                      // graduación a long-term
  // lifecycle (entryId nulo):
  | "task_start" | "milestone_advance" | "task_complete";

type DossierEvent = {
  seq: number;              // orden monotónico (≈ nro de línea del JSONL)
  ts: string;               // ISO
  taskId: string;           // a qué misión pertenece
  sessionId: string;        // SIEMPRE — la unidad mecánica (un Runner.run)
  milestone?: number;       // OPCIONAL — capa semántica, solo si hubo plan
  actor: "agent" | "system";
  op: Op;
  entryId?: string;         // opcional (nulo en eventos de ciclo de vida)
  delta?: Partial<Entry>;   // qué cambió (para leer la mutación)
  snapshot?: Entry;         // estado completo de la entry tras aplicar
};

type Entry = {
  id: string;
  type: "decision" | "gotcha" | "task" | "file" | "observation";
  text: string;
  state?: "open" | "done" | "migrated" | "dropped";
  threadId?: string;         // patrón de dos notas
  targetMilestone?: number;  // forward-carry (opcional, ver abajo)
  refs?: { path?: string; line?: number; toolUseId?: string };
  rationale?: string;        // el "por qué" acoplado a la acción
  justification?: string;    // defensa de migración / supervivencia
  tokens?: number;           // peso estimado (chars/4)
};
```

### Decisiones del shape

- **Delta + snapshot juntos** en cada evento. Redundante pero las entries son
  chicas. Premio: el **dossier vivo actual = último snapshot por `entryId`**
  (`max(seq) GROUP BY entryId`, sin foldear); el fold solo se necesita para la
  *historia*.
- **`milestone` opcional.** La unidad siempre presente es `sessionId` (un
  `Runner.run`, existe hasta para un one-off). El milestone es la capa semántica
  que solo aparece con plan, y es 1:N con sesiones (un milestone que revienta el
  budget se parte en varias). Degrada con gracia: sin plan no hay milestones,
  las fronteras del ritual caen sobre **fin de sesión**; con plan se agrega la
  consolidación de **fin de milestone** + chequeo de re-planning.
- **`targetMilestone` opcional.** En modo sesión-pelada migrar = "llevar a la
  próxima sesión", no a un milestone numerado.
- **Ops granulares** (transiciones como ops distintos, no un `setState`
  genérico) para que el análisis sea `GROUP BY op` trivial.
- **`actor: agent | system`** separa la conducta de note-taking del agente de la
  política del sistema (evicción) — clave para el análisis.

### Store

- **JSONL = fuente de verdad** (append puro, ownable, cero dep). Formato
  `.omega/dossiers/<taskId>.jsonl`.
- **SQLite = proyección derivada opcional**, reconstruible del log cuando se
  quiera SQL para métricas. `node:sqlite` anda en Node 22.22 **sin flag** (solo
  warning de experimental) → cero deps externas, sin binding nativo que se
  rompa. Diferible: el log es la verdad, la DB se bolt-onea después sin rework.

### Qué se puede medir del log (para mejorar omega)

- Tasa de migración (¿la fricción funciona o el agente migra todo?).
- Entries que migran mucho y nunca se accionan (peso muerto del planner).
- Gotchas que recurren entre tareas (candidatas al `AGENT.md`).
- **Evicciones que después se re-crean** (mismo `threadId`) = señal dura de
  budget muy apretado → costo de re-descubrimiento.
- Trayectoria de tokens del dossier a lo largo de la tarea (cada evento carga
  su `tokens`).

---

## 9. Decisiones tomadas (resumen)

1. Multi-session orquestado por encima de `Runner.run`, contexto fresco por
   sesión.
2. Dossier estilo Bullet Journal: tipos + migración + threading.
3. El dossier es un índice, no un archivo (re-hidratación on-demand).
4. Cinco tipos de entry, no más.
5. Fricción = budget de tokens (techo) + justificación (desempate), montada
   sobre la prioridad por tipo.
6. Migración (borde, agent, justificada) vs evicción (mid-session, system).
7. Tres niveles de memoria; promoción dossier → long-term; long-term v1 =
   `AGENT.md` wholesale (sin retrieval).
8. Event sourcing; live dossier = fold; log nunca entra al contexto.
9. Evento con delta + snapshot; `milestone`/`targetMilestone` opcionales;
   ops granulares; `actor`.
10. JSONL fuente de verdad + SQLite proyección opcional (`node:sqlite`).

---

## 10. Pendiente de diseñar

- **Protocolo de emisión.** Cómo el agente emite las entries sin gastar turnos:
  - `rationale` obligatorio acoplado a `edit`/`write` (el schema fuerza; si
    falta, la tool rechaza — mismo patrón que el BLOCK del clasificador de bash).
  - Tools `note` / `decide` para entries no acopladas (decisiones de
    exploración sin mutación).
  - Dónde se traza la línea entre forzar en mutaciones (barato, ~80%) vs forzar
    en exploración (caro).
- **El Planner**: formato del plan, criterios de aceptación, re-planning.
- **El ritual de migración**: quién lo corre (call dedicada vs el propio agente
  al cerrar), y cómo se aplica el budget+justificación en la práctica.
- **Retrieval de long-term** (solo cuando `AGENT.md` wholesale deje de alcanzar).
- **Proyección SQLite + queries de métricas** (cuando se quiera explotar el log).

---

## 11. Qué es irreversible

**Solo el shape del evento (§8)** — es la fuente de verdad. Todo lo demás
(store, proyecciones, índices, retrieval, el protocolo de emisión) se
bolt-onea/cambia después *desde el log*, sin reescribir nada. Por eso la
secuencia sana es: **clavar el schema del evento ahora, diferir el resto.**
