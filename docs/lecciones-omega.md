# Lecciones de construir omega

Retrospectiva de todo lo aprendido construyendo omega desde cero — un harness
agéntico en TypeScript, a mano, para entender cada línea. No es doc de diseño;
es el mapa de los muros que choqué y por qué cada uno enseñó algo.

El capítulo de **contexto y caching** tiene su propio deep-dive en
`lecciones-contexto-caching.md`; acá va condensado.

---

## 0. Por qué construirlo

omega no existe para reemplazar a Claude Code. Existe para **entender** cómo
funciona un agente de coding por dentro, construyéndolo. Soy power-user de Neovim;
quiero ser dueño de mi tooling y de cada decisión. El método fue **bootstrapping**:
usar omega (con un modelo barato, DeepSeek vía OpenRouter) para mejorar omega,
con todas las decisiones de arquitectura pasando por mí.

La lección cero: el objetivo no era productividad, era comprensión. Eso cambia qué
cuenta como "éxito" — un bug entendido vale más que una feature que anda y no sé
por qué.

---

## 1. El loop agéntico (los fundamentos)

- El modelo es **stateless**. En cada step se le re-manda TODO el historial. No
  "recuerda" — vos le recordás reenviando.
- El costo está manejado por **input tokens × steps × tareas**. El driver no es
  la respuesta del modelo (output), es el contexto que se reenvía en cada ronda
  de tool. Ratios input:output de 100:1 o 170:1 son normales.
- Una "tarea" puede ser 1 step o 250 steps. El costo y el contexto crecen por
  **step agéntico**, no por turno de usuario. (Esto me costó entenderlo y volvió
  a morder en el dossier.)

---

## 2. Una TUI desde cero

Lo más artesanal del proyecto, y donde más bugs sutiles aparecieron.

- **Raw mode**: tomás control total del input. Regla de oro: **restaurar siempre
  al salir** (`process.on("exit")`, y en cada `exit`/error), si no dejás la
  terminal rota.
- **Posicionamiento RELATIVO, no absoluto.** Moverse con CUU/CUD/CR/ED0 relativo
  a donde está el cursor — nunca con save/restore absoluto (`\x1b7`/`\x1b8`),
  porque el absoluto se rompe apenas la pantalla scrollea.
- **Líneas lógicas (`\n`) ≠ líneas visuales (con wrap).** El bug recurrente de
  toda la TUI. Una línea más larga que el ancho de la terminal ocupa varias
  filas visuales. Si contás los `\n`, contás de menos → el clear/redraw sube de
  menos → cascada de barras por cada tecla. Se arregla contando filas visuales
  con `ceil(len/width)` y respetando el **deferred wrap** (un cursor en la última
  columna no baja de fila hasta el próximo carácter).
- **Strippear ANSI antes de medir.** Los códigos de color inflan el largo del
  string y rompen el conteo visual.
- **El modelo "prompt fijo abajo" (Screen):** un editor vivo en la última línea;
  todo el output del programa va por `printAbove` (scrollback ARRIBA del editor),
  nunca directo a stdout (pisaría el editor). Slots separados: `#live` (editor),
  `#status` (spinner), `#ephemeral` (línea parcial de streaming). **Mezclar
  `#status` y `#ephemeral` causó que el spinner pisara el streaming.**
- **Streaming:** flusheás líneas completas al scrollback y mantenés solo la línea
  en progreso como efímera truncada. Faltaba un `\n` (LF) y se veía "solo la
  última línea".

Lección transversal de la TUI: **estas features no se pueden verificar con tests
unitarios.** Compilan, los tests pasan, y se ven rotas en pantalla. Hay que
probarlas en vivo, tipeando.

---

## 3. Interrupciones (Ctrl+C / Esc) — más difícil de lo que parece

- Un `AbortController` por turno; Ctrl+C aborta el signal en vez de matar el
  proceso.
- **El bug:** el listener de abort se removía después de recibir los headers del
  `fetch`, pero ANTES de leer el body del stream → no se podía interrumpir un
  poema de 500 líneas a mitad. Fix: el listener vive en el `finally` después del
  loop de lectura, y `reader.cancel()` para desbloquear el `reader.read()`.
- El runner chequeaba `aborted` solo **entre** steps, no durante el consumo del
  stream. Para interrumpir de verdad hay que chequear adentro del loop de lectura.
- Lección: la interrupción es un problema de **lifecycle de recursos**, no un
  if. Hay que pensar dónde está bloqueado el await y cómo se lo desbloquea.

---

## 4. Providers y OpenRouter

- **OpenRouter rutea por PRECIO por default** → puede mandarte a un provider
  lento. `provider: { sort: "throughput" }` o el slug `:nitro` para velocidad.
- **El tail de ~21s:** el provider mantenía el socket abierto después de mandar
  el contenido. La cola del stream esperaba el chunk final de `usage`. Fix:
  cortar el loop al ver el sentinel `[DONE]`, si no `reader.read()` queda
  bloqueado ~90s.
- **El cost meter roto:** `calculateCost("")` con modelo vacío devuelve siempre
  0. Y DeepSeek no estaba en la tabla de precios → también 0. El costo real
  necesita `usage.cost` de OpenRouter (con `usage: { include: true }` en el body).
  Volé a ciegas con el gasto por esto (me gasté ~$30 en 3-4 días sin verlo).
- **Prompt caching** (deep-dive aparte): la palanca de costo número uno; ver
  `lecciones-contexto-caching.md`.

---

## 5. El clasificador de seguridad (auto-mode)

Inspirado en el auto-mode de Claude Code:

- Un LLM **barato** evalúa cada comando bash antes de ejecutarlo. Si matchea un
  override conocido, no llama al LLM (cache). En error → **fail-safe a
  DANGEROUS**.
- Cuando bloquea, le devuelve al agente un mensaje que lo instruye: no reintentes
  otra sintaxis, informá al usuario, usá `ask_user`, y si confirma, re-llamá con
  `force: true`.
- Debate abierto que quedó: **un blacklist determinístico como "piso"** para
  comandos catastróficos (`rm -rf /`, `mkfs`, `dd of=/dev/disk`) que el
  clasificador no debería poder overridear. Un clasificador LLM es best-effort,
  no un sandbox.
- Lección: la seguridad en capas. El clasificador es una capa, no LA capa.

---

## 6. Gestión de contexto (el arco largo — condensado)

Detalle completo en `lecciones-contexto-caching.md`. Lo esencial:

- **El caching ya resuelve el costo** del crecimiento de contexto (append-only =
  prefijo estable = ~90% cacheado). Gestión de contexto y caching están en
  **tensión**: achicar = mutar = romper el cache.
- Los tres problemas son distintos: **costo** (lo cubre el caching), **límite de
  ventana** (no llego, ~60-70k de 128-200k), **rot** (real pero leve a mi escala).
- El dossier estilo Bullet Journal (tipos, migración, event sourcing, fold) era
  una buena idea **mal implementada**: folddear cada step rompió el cache (90%→0%)
  y el windowing por turnos no acotaba mi caso (pocos turnos, muchos steps).
- El diseño correcto: **compactar periódico (cada K steps), no continuo** —
  amortiza la rotura del cache. Lo derivé solo; es la rama "Cura" del estado del
  arte.
- Herramientas que quedaron: `scripts/context-growth.ts` (grafica el contexto por
  step) e instrumentación `stepUsage` (input/cached/cost real por step).

---

## 7. Bootstrapping con un modelo barato (DeepSeek)

Construir omega CON omega corriendo un modelo barato enseñó tanto del modelo como
del harness.

**Lo que el modelo barato hace mal** (y hay que vigilar):
- **Reescribe archivos enteros y dropea features sin avisar.** Al meter el
  dossier, borró silenciosamente toda la instrumentación `stepUsage` que ya
  andaba.
- **Declara "done" sin verificar en vivo** — tres rondas seguidas dijo listo con
  el dossier vacío / sin correr nada real.
- **Hace la parte fácil y saltea la portante.** Computó el fold pero no reemplazó
  la historia (lo dejó aditivo). Implementó el windowing por la granularidad
  equivocada.
- **Introduce errores de tipos** y los deja pasar si no corre tsc.

**Lo que hace bien:**
- El núcleo determinístico (tipos, JSONL, fold) — testeable sin agente vivo.
- La lógica una vez especificada con precisión (lastTurns, el guard de orphans).

**La disciplina que funcionó:**
- **Prompts precisos y prescriptivos**, no conceptuales — un modelo barato
  implementa literal.
- **Verificación viva OBLIGATORIA** como parte del "done" — pegar el artefacto
  real (el JSONL, el chart), no la palabra.
- **Review sobre artefactos, no sobre reportes.** Los datos no mienten; el "está
  listo" sí.
- **No editar el código mientras el modelo trabaja** — escribir prompts, no
  pisarle el laburo.

---

## 8. Las meta-lecciones (las que valen para todo)

1. **Compila ≠ funciona. Tests verdes ≠ funciona.** Lo conductual (la TUI se ve
   rota, el agente pierde memoria, el cache se cae) solo aparece corriendo en
   vivo. Pasó en la TUI, en la interrupción y en el contexto.
2. **Para debuggear cuelgues, instrumentá con timestamps — no adivines.** El tail
   de 21s y el SIGINT se resolvieron midiendo dónde estaba bloqueado, no
   teorizando.
3. **Medí, no asumas.** El costo real del dossier recién apareció con datos de
   caching reales, después de que todo "se veía bien".
4. **Verificá sobre artefactos reales**, no sobre "done".
5. **Construir lo equivocado es parte del camino.** No se deriva la solución
   correcta sin sentir por qué la primera falla.
6. **Distinguí los problemas antes de resolverlos.** Costo, ventana y rot son
   tres cosas distintas; tratarlas como una lleva a construir lo que no necesitás.
7. **El objetivo era entender.** Cada muro entendido es el producto, no un costo.

---

## 9. Estado del proyecto y qué sigue

omega ya cumplió su objetivo central: entender cómo funciona un agente
construyéndolo, línea por línea. Lo que quede por hacer (terminar el dossier en
su versión liviana, explorar sub-agentes, el blacklist del clasificador, el
outline tool) es opcional y sin apuro.

Docs relacionados: `lecciones-contexto-caching.md` (deep-dive de contexto/caching),
`dossier-design.md`, `multisession-orchestration-design.md`, `benchmarking-design.md`,
`harness-improvements.md`.
