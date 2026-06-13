# Omega — Diseño del sistema de memoria (cabinet)

**Estado:** Diseño / visión. No implementado.
**Fecha:** 2026-06-12
**Contexto:** Surgió de una sesión de diseño larga. Es la *visión* del sistema de
memoria de largo plazo de omega. No hay que construir todo esto de una — ver
"Fases" al final. La arquitectura se gana con el uso, no se inventa de antemano.

---

## 1. Problema

Dos dolores que resultan ser el mismo:

- **Gestión de contexto.** El modelo es stateless: cada llamada reenvía todo el
  historial. El contexto crece y se llena de cosas rancias (outputs de tools
  viejos, archivos leídos hace 10 turnos). Más contexto ≠ mejor: cuesta tokens,
  agrega latencia, y degrada la atención ("lost in the middle").
- **Memoria entre sesiones.** Hoy omega no recuerda nada de una sesión a otra.

La solución a los dos es la misma pieza: una memoria de largo plazo en disco.

## 2. Modelo mental

Dos memorias, y el trabajo del agente es **mover cosas entre ellas**:

- **Memoria de trabajo** = la ventana de contexto (efímera, por sesión).
- **Memoria de largo plazo** = el cabinet (persistente, en disco, entre sesiones).

El agente hace dos movimientos:
- **Recall:** traer del cabinet al contexto solo lo relevante.
- **Consolidación:** empujar hallazgos durables del contexto al cabinet.

Metáfora guía: el contexto es una **mesa de trabajo**, se mantiene ordenada con
solo lo que se necesita ahora; el cabinet es el **cajón**; el `INDEX` es cómo
encontrás la herramienta en el cajón.

## 3. Formato: Markdown como fuente de verdad

El cabinet tiene dos lectores con necesidades opuestas:

- **El humano** (browsea en Obsidian): HTML es más expresivo.
- **El agente** (recall): HTML es **caro y ruidoso** — 2-4x los tokens del mismo
  contenido en MD, con tags que el modelo tiene que ver-a-través. Pelea contra
  toda la disciplina de contexto.

**Decisión:** Markdown es la fuente de verdad (liviano para el agente, diffs
lindos, version-control). Se **renderiza a HTML on-demand** para el ojo humano
(el `server.ts` con `marked` ya hace esto). Fuente vs presentación: el agente
lee MD lean, el humano ve HTML expresivo. Nadie cede nada.

## 4. Topología de scope (en cascada, como git config)

El conocimiento tiene dos escalas genuinas:
- **Atado al proyecto:** arquitectura de *este* repo, decisiones de *este* ticket.
- **Transversal / personal:** preferencias, patrones que cruzan proyectos.

Por eso, dos tiers no es over-engineering — espeja la realidad. Modelo git:
`~/.gitconfig` global + `.git/config` por repo.

- **Proyecto:** caminar hacia arriba desde el cwd buscando `.omega/cabinet/`
  (como git busca `.git`).
- **Global:** ubicación fija, `~/.omega/cabinet/`.
- **Recall:** leer ambos índices; lo de proyecto pesa más por específico.
- **Escritura:** rutear por scope — específico del repo → proyecto; general → global.

La idea de "global que apunta a cabinets por proyecto" NO es un modelo aparte:
es **búsqueda cross-proyecto** montada encima de la cascada (un registro en el
global que indexa los cabinets de proyecto). Se difiere hasta tener varios
cabinets y sentir el dolor.

## 5. Estructura: lean, emerge del uso

El cabinet actual (de Claude Code) no se diseñó, *emergió* de iterar. El de omega
va a emerger igual, y puede ser distinto porque omega se comporta distinto.
**No pre-diseñar la taxonomía perfecta.** Arrancar con `INDEX` + dos o tres
carpetas obvias y dejar que las categorías aparezcan.

Dos capas, esto sí es invariante:

- **INDEX** = catálogo **fino**, siempre cargado (eager, barato). Solo punteros:
  título + una línea + link + status. **No contenido.** Si engorda (el cabinet
  actual tiene un INDEX de 37KB), deja de ser un catálogo barato.
- **Docs** = el contenido, traídos selectivamente (lazy, caro).

## 6. Workflow

### Compuerta — qué se consolida
Regla: **alto costo de re-derivar × vida media larga = consolidá.** Bajo en
cualquiera de los dos = que muera en la sesión.
- Sí: decisiones y su *por qué*, hallazgos de investigaciones, gotchas no obvios,
  modelos mentales de cómo funciona un sistema.
- No: cosas que grep recupera al toque, estado efímero, nada que el código/tests
  ya encoden.
- **Anti-patrón clave:** nunca snapshotear algo con fuente de verdad viva (el
  código es la verdad de "qué hace el código"). El cabinet es para lo que el
  código NO captura: el por qué, la historia, el entendimiento transversal.

### Recall — INDEX eager, docs lazy
Progressive disclosure: cargás el catálogo (INDEX) siempre, traés el ítem (doc)
cuando la entrada se ve relevante.

### Frescura del índice — la disciplina de mayor leverage
Como el INDEX es lo único que se lee siempre, mantenerlo verdadero hace toda la
memoria descubrible. **Consolidar no está terminado hasta que el índice está
actualizado** — escribir el doc y registrarlo en el índice son una operación
atómica. Un doc sin entrada en el índice está, de hecho, olvidado. Validar
periódicamente: links rotos (ya lo hace `validate-index.sh`) + docs huérfanos.

## 7. Autonomía: escribir solo, pero saber olvidar

Asimetría con las acciones peligrosas: escribir al cabinet **no es destructivo**
(es append, reversible vía git). Pedir confirmación por cada nota sería molesto
para algo inofensivo. Así que la escritura puede ser autónoma.

El riesgo real no es daño, es **polución / rot**: el modelo sobre-guarda y el
cabinet se llena de docs marginales.

**Insight central:** el peligro no es la escritura autónoma, es la escritura
autónoma **sin olvido autónomo.** Una memoria que solo crece se pudre, por más
estricta que sea la compuerta (las compuertas gotean, la relevancia decae).
La memoria humana funciona porque olvidamos. → El fix no es una compuerta más
apretada, es **podar**. Remember *and* forget.

## 8. Sueño: dos fases (vigilia / sueño)

omega tiene dos fases, como la memoria biológica:
- **Vigilia:** hace tareas, acumula memoria cruda y rápida (compuerta estricta).
- **Sueño:** sesión de housekeeping que consolida, poda e integra.

### Qué hace un sueño (mapea al sueño biológico)
- **Consolida:** replay de lo reciente (logs, docs nuevos) → integrar a la
  estructura de largo plazo.
- **Poda:** archivar lo rancio / marginal / duplicado.
- **Integra:** mergear duplicados, linkear relacionados, refrescar el INDEX.

### El regalo arquitectónico
Una sesión de sueño es **simplemente otro `AgentConfig` corrido por el mismo
`Runner`.** Un omega-que-codea y un omega-que-sueña son la misma máquina con
distinta personalidad (system prompt de housekeeping, toolset acotado al cabinet,
quizás modelo más barato porque podar es mecánico). La separación
`AgentConfig` ↔ `Runner` da el "soñar" casi gratis: es un prompt + un trigger,
no un subsistema nuevo.

### Triggers ("cada cierto tiempo o bajo ciertas condiciones")
- **Tiempo:** sueño nocturno = un cron/launchd que corre omega en modo-dream.
  (Lo más simple para arrancar.)
- **Presión:** cuando el cabinet cruza un umbral de desorden (N docs, INDEX > X KB,
  duplicación). Mapea a la "presión de sueño": se acumula, gatilla, se resetea.
  (Lo más elegante.)
- **Manual:** un `/sleep`.

### Cautelas
- **Archivar, no borrar.** El olvido es mover a `archive/`, no `rm` — reversible,
  con git de red. Un pruning mal hecho no destruye nada irrecuperable.
- **Dejar un dream-log.** El sueño muta tu segundo cerebro autónomamente; tiene
  que dejar un changelog de qué consolidó/podó/mergeó, para revisar async (como
  recordar un sueño). Observabilidad.
- **Cuesta tokens.** Leer todo el cabinet es pesado → no muy frecuente, modelo
  barato para lo mecánico, el trigger por presión lo rate-limitea solo.

## 9. Notas de arquitectura

Casi todo esto es **prompt + convención**, no código. omega ya tiene
`read`/`write`/`edit`/`bash` para operar sobre archivos. Lo único que es código
real:
- Un **resolver de cabinet** (~20 líneas): dado el cwd, devuelve el path del
  cabinet de proyecto (walk-up) y el global.
- Quizás un `validate` mejorado (links rotos + docs huérfanos).
- Reusa `Runner` y `AgentConfig` para el modo sueño.

El cabinet debería ser **auto-describible**: un README/AGENTS.md adentro que
documente las convenciones, que omega (y Claude Code) leen on-demand. Patrón
"CLI tool + README" de Pi aplicado a la memoria.

Capacidad linda que se abre: si dos agentes (omega y Claude Code) apuntan al
mismo cabinet, **comparten memoria de largo plazo.** Dos agentes, un cerebro.

## 10. Fases (no construir todo de una)

1. **Cabinet de proyecto** con estructura mínima + INDEX. omega lee/escribe vía
   las tools que ya tiene. Convención + prompt.
2. **Compuerta + recall** en el system prompt (qué guardar, INDEX eager/docs lazy,
   atomicidad doc+índice).
3. **Tier global** (`~/.omega/cabinet/` + resolución en cascada) cuando aparezca
   la necesidad de memoria transversal.
4. **Sueño** (modo housekeeping = AgentConfig nuevo), primero trigger manual/tiempo,
   después por presión.
5. **Registro cross-proyecto** (búsqueda entre cabinets). Diferir más que nada.

## 11. Decisiones abiertas

- Estructura/taxonomía concreta del cabinet v1 (dejar emerger).
- Workflow de recall: ¿el INDEX se inyecta al system prompt, o omega lo lee con
  una tool al arrancar?
- Trigger exacto del sueño y umbrales de presión.
- ¿El dream-log vive en el cabinet o aparte?

---

## 12. Workspaces y multi-agente (visión más amplia)

> Excede la memoria, pero engancha: el Workspace es el contenedor natural del
> cabinet y de las sesiones. Visión, no implementación. Difiere hasta sentir la
> necesidad.

### Observación que lo dispara
Claude Code (y omega hoy) son **una conversación lineal = un contexto.** Cambiar
de modelo no te da un agente nuevo: le pasás el mismo historial al modelo nuevo,
que lo re-lee entero. No hay forma de tener N agentes con contextos *separados*
que se comuniquen.

### La idea: modelo de actores aplicado a agentes
Actores independientes, cada uno con estado privado (su contexto), que se
comunican por **mensajes compactos**, no compartiendo historiales.

Y el punto clave: **es una estrategia de contexto.** En vez de un contexto
gigante y contaminado, tenés varios agentes especializados, cada uno con un
contexto chico y limpio, que se pasan **conclusiones, no sus historiales.** Es el
argumento de los sub-agents de Mario: el hijo trabaja en su contexto y devuelve
solo el resultado, manteniendo limpio al padre. Multi-agente-con-contextos-
aislados *es* gestión de contexto por otra vía.

### Layering
- **Workspace** = el contenedor. Posee el proyecto/cwd, el cabinet, el registro
  de sesiones, y el canal de comunicación.
- **Session** = un agente = un contexto. Posee su historial y su `AgentConfig`
  (modelo, prompt, tools).
- **Comunicación** = las sesiones se pasan mensajes compactos, o comparten
  archivos (el cabinet como blackboard).

### omega ya está ~90%
Una Session es un `Runner` + `AgentConfig` + historial — los tres ya existen.
Distintos `AgentConfig` = distintos modelos/prompts por agente (el "cambiar de
modelo" pero como agentes *separados*, no un contexto que muta). Falta:
- El **Workspace** como contenedor arriba de las sesiones.
- El **mecanismo de comunicación**. Versión Pi: por archivos (cabinet de
  blackboard), cero IPC. Versión rica: message-passing / mailboxes (actores).

### Conexión con la memoria
El Workspace es el dueño natural del cabinet. Los agentes de un workspace
comparten el cabinet como blackboard y como memoria de largo plazo. El "sueño"
es una sesión más dentro del workspace.

### Decisiones abiertas
- ¿Comunicación por archivos (blackboard) o message-passing real?
- ¿Quién orquesta — un agente padre, o el Workspace como scheduler?
- ¿Cómo se persiste/reanuda un Workspace entero (varias sesiones a la vez)?
