# Lecciones: contexto, caching y agentes

Retrospectiva de lo aprendido construyendo el dossier para omega. No es un doc
de diseño (esos están en `dossier-design.md` y `multisession-orchestration-design.md`);
es lo que entendí en el camino, con los muros que choqué y por qué importan.

---

## TL;DR (si leés solo esto)

1. **El caching ya resuelve el costo del crecimiento de contexto.** Re-mandar la
   historia que crece es casi gratis si el prefijo es estable: solo el contenido
   nuevo paga full, las re-lecturas van al ~10%.
2. **Gestión de contexto y caching están en tensión.** Achicar el contexto =
   mutarlo = romper el cache. No hay free lunch.
3. **El costo era un fantasma; la ventana también; el rot es real pero leve a mi
   escala** (~60-70k tokens por step, bien abajo del límite).
4. **Compactar PERIÓDICO (cada K steps), no CONTINUO (cada step).** Lo continuo
   rompe el cache 250 veces; lo periódico lo rompe ~5 veces (amortizado).
5. **El premio no era el ahorro: era entender.** Y entender de verdad vino de
   chocar cada muro, no de leer sobre ellos.

---

## 1. El problema que creía tener vs. el que tenía

Arranqué pensando: "el contexto crece cuadráticamente (input × steps), las
sesiones largas son carísimas, hay que achicar el contexto". Medí una sesión real
(`classifier`): 270 steps, **18M tokens de input**. Parecía el problema.

Resultó que de los tres problemas que la gestión de contexto podría resolver, dos
eran fantasmas para mi caso:

| Problema | ¿Real para mí? | Por qué |
|----------|----------------|---------|
| **Costo** | Fantasma | El caching lo hace barato (ver §2). |
| **Límite de ventana** | Fantasma | Mi contexto por step se queda en ~60-70k; la ventana es 128-200k. Estoy al 30-50%. |
| **Context rot** (el modelo razona peor en contexto grande) | Real, pero leve | A 60-70k está presente pero suave. Pega fuerte a 150k+. |

Los "18M" / "2M" que me asustaban eran la **suma a lo largo de los steps**, no un
solo contexto gigante. Un solo contexto nunca se acercó a llenar la ventana.

---

## 2. Prompt caching — la pieza que lo cambia todo

**Cómo funciona una llamada al modelo:** el modelo no tiene memoria. En cada step
omega le re-manda TODO (system + historial) y el modelo lo lee de arriba a abajo.

**Qué es el caching:** el proveedor cachea el **prefijo** — desde el arranque
hasta el primer punto donde el prompt difiere del de la llamada anterior. Si el
principio es idéntico, reusa lo procesado y cobra ~10× menos por esa parte.

**Por qué hace barato el crecimiento:** con append-only (solo agregás al final),
el prefijo es siempre el mismo que la vez anterior. Solo el pedacito nuevo paga
full; las re-lecturas van al 10%. El costo cuadrático se aplasta a ~lineal. Por
eso mi sesión de 18M salía baratísima: **~90% cacheado** (lo vi en el dashboard
de OpenRouter).

Dato de la comunidad: el prompt caching baja el costo **41-80%** (75-90% en
producción). Es la palanca de costo número uno.

---

## 3. La tensión fundamental

Para arreglar el **rot** o el **límite de ventana** hay que **achicar** el
contexto. Achicar = mutar el prompt (dropear, comprimir, resumir). Y cualquier
mutación cerca del principio **rompe el cache** de ahí para abajo.

```
Contexto chico  = mejor calidad + entra en la ventana + CARO (sin cache)
Contexto grande = rot + tope de ventana + BARATO (cacheado)
```

No se pueden tener las dos a la vez. Esta es la lección central, y la aprendí a
los golpes: la primera versión del dossier metía un resumen ("fold") que cambiaba
**arriba** del prompt en **cada step** → rompió el cache de **90% a 0%** → salió
**más caro** que no hacer nada, aunque mandara menos tokens.

---

## 4. El dossier: la idea y por qué la implementación falló

**La idea:** en vez de re-mandar todo el historial, destilarlo en notas
estructuradas ("el fold") e inyectar eso. Modelado como un **Bullet Journal**:

- **Tipos de nota** (signifiers): decision, gotcha, task, file, observation.
- **Migración + threading**: una decisión que implica trabajo futuro genera dos
  notas enlazadas (la observación ahora + la task después).
- **Event sourcing**: el dossier vivo es un *fold* sobre un log append-only
  (JSONL); el log nunca entra al contexto, solo el fold acotado.
- **Tres niveles de memoria**: working context (sesión) → dossier (tarea) →
  long-term (proyecto, vía promoción a AGENT.md).

**Por qué falló en la práctica** (todo descubierto en corridas reales, no en
tests):

1. **Folddear cada step rompió el cache** (90%→0%) → más caro. *Lección: el fold
   dinámico no puede ir en el prefijo cacheable.*
2. **El windowing por "turnos de usuario" no acotó nada en mi caso.** Yo hago
   pocos turnos (4-5) y muchos steps. `lastTurns(K)` con menos de K turnos
   devuelve todo. *Lección: el costo crece por steps agénticos, no por turnos.*
3. **El windowing agresivo (8k) causó amnesia.** Anclaba en la última instrucción
   y tiraba toda la conversación previa → el agente decía "primer intercambio",
   olvidaba la tarea, inventaba paths. *Lección: hay que distinguir CONVERSACIÓN
   (chica, esencial, se preserva) de RUIDO DE TOOLS (grande, re-derivable, se
   acota).*
4. **Bug de orphans**: el recorte dejaba `tool_result` sin su `tool_use` → 400 del
   provider.
5. **El dossier no ahorró nada en una tarea de un turno / muchos steps** — el caso
   exacto de mi día a día.

---

## 5. El diseño correcto (al que llegué solo, y que usa la industria)

**Compactar PERIÓDICO, no CONTINUO.** En vez de folddear cada step:

- Steps 1..K: append-only → **cacheado → barato**. El contexto crece tranquilo.
- En el step K: **reemplazás** la historia por el dossier (compactación, UNA vez).
  El cache se rompe **acá nomás**.
- Steps K+1..2K: append-only de nuevo desde la base chica → **cacheado otra vez**.
- Repetís.

Resultado: de 250 steps, ~245 quedan cacheados-baratos y ~5 son los caros (los
puntos de compactación). **Amortizás la rotura del cache** y acotás el contexto.
El dossier (las notas que el agente fue emitiendo) es el artefacto con el que
reemplazás — no necesitás ni una call extra de resumen.

**Alternativa barata sin achicar nada:** poner el fold **al final** del prompt (no
arriba). Así el prefijo `system + historial` queda estable → cacheado; solo el
fold chico al final paga full. No reduce contexto, pero **pelea el rot barato**
re-surfaceando lo importante en la posición de máxima atención del modelo.

---

## 6. Qué hace la comunidad (estado del arte 2026)

Dos filosofías:

- **Prevención** — acotar el crecimiento estructuralmente (capear rondas de
  búsqueda, limitar resultados mostrados, resetear por nodo). Ej: AutoCodeRover,
  Moatless.
- **Cura** — dejar crecer y comprimir al pasar un umbral (resumen por LLM). Ej:
  Aider, OpenHands, Gemini CLI, Codex CLI. **Mi "compactar cada K steps" es esto.**

Otras piezas:
- **Sub-agentes / aislamiento de contexto**: descomponer en sub-tareas con
  contexto fresco y chico, que devuelven solo el destilado ("compartí memoria
  comunicando"). Es la respuesta más fuerte al caso de un turno / muchos steps —
  pero decidí no usar sub-agentes.
- **Diseño cache-first**: poner lo estable (tool schemas, instrucciones) al frente
  para que cachee. Confirma exactamente lo que descubrí.
- **Memoria en capas + retrieval** (vector DB, similitud semántica) para el largo
  plazo.

**Lo que derivé solo antes de buscarlo:** el note-taking estructurado (= Cura), el
modelo Bullet Journal, el event sourcing del log, que el windowing va por steps,
el fold al final por caching, y la compactación periódica cada K steps. Todo
patrones del estado del arte, reconstruidos desde cero.

---

## 7. Meta-lecciones (las que valen para todo, no solo esto)

1. **Medí, no asumas.** Cada capa se veía bien (emisión anda, windowing acota
   tokens) y el costo real recién apareció al final, con datos de caching reales.
2. **Compila ≠ funciona. Tests verdes ≠ funciona.** Lo conductual (el agente
   pierde memoria, el cache se rompe) solo aparece corriendo en vivo. tsc en verde
   me ocultó tres bugs distintos en tres rondas.
3. **Construir lo equivocado es parte del camino.** No podés derivar la
   compactación periódica sin sentir por qué la continua rompe el cache. El error
   era información, no pérdida de tiempo.
4. **El caching es el primer lever de costo, no la gestión de contexto.** Antes de
   optimizar tokens, mirá el cache.
5. **Verificá sobre artefactos reales, no sobre "está listo".** El JSONL del
   dossier vacío, el `cached: 0`, el `stepUsage` ausente — los datos no mienten;
   los reportes de "done" sí.
6. **Distinguí los problemas antes de resolverlos.** Costo, ventana y rot son tres
   problemas distintos con tres soluciones distintas; tratarlos como uno lleva a
   construir lo que no necesitás.

---

## 8. Herramientas que quedaron (sirven aunque no termine el dossier)

- **`scripts/context-growth.ts`** — reconstruye/grafica el contexto por step de
  una sesión. Modo real (si hay `stepUsage`) o estimado (chars/4, ~2% de error).
- **Instrumentación `stepUsage`** — input/output/cached/cost real por step en la
  sesión. Sin esto se mide a ciegas (y el cost meter mostraba $0 para DeepSeek por
  no estar en la tabla de precios).
- **El log de eventos del dossier (JSONL)** — aunque el dossier no se use en
  producción, el patrón de event sourcing + análisis offline quedó entendido.

---

## 9. Decisión abierta

A mi escala actual (~60-70k por step, bajo la ventana, cacheado), el problema de
contexto **casi no me duele**. Opciones:

- Dejarlo como aprendizaje cerrado y volver a `cache + compactStaleReads` (ya
  alcanza).
- Meter la versión liviana (compactar cada K + fold al final) como ejercicio de
  craft y para futuro-proofear cuando las tareas crezcan.
- Retomar sub-agentes algún día (la rama que no exploré).

Sin apuro. El objetivo de omega —entender cada línea construyéndola— ya se
cumplió.
