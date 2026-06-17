# Benchmarking de modelos en omega — diseño

Cómo medir y comparar distintos modelos corriendo en omega: correctitud, costo,
eficiencia y velocidad, de forma reproducible.

## El principio que ordena todo

El repo de tareas es la parte fácil. **Lo difícil —y lo que de verdad importa— es
el verificador.** Un benchmark agéntico no es "un repo con tareas", es un set de:

```
tarea = (estado inicial del repo, prompt, chequeo objetivo de éxito)
```

Sin un chequeo automatizado por tarea, terminás mirando a ojo cada corrida × cada
modelo y no escala. Es la idea de SWE-bench: la tarea es un repo en cierto estado +
un problema + un test escondido; **éxito = el test pasa después de los cambios del
agente.** El repo canónico tiene que estar hecho de tareas donde el éxito lo decide
un script (corre tests, compara un diff, chequea un output), no tu criterio.

## El eje cero es correctitud

Costo, eficiencia y velocidad solo tienen sentido **condicionados a que la tarea
salió bien**. Un modelo barato y rápido que entrega mal no vale nada. El orden de
evaluación es:

1. ¿Resolvió la tarea? (pass/fail objetivo)
2. Entre los que resolvieron: ¿cuánto costó / cuántos pasos / cuánto tardó?

Si no medís correctitud primero, estás comparando lo barato que es equivocarse.

## Las métricas, una por una

- **Costo** (tokens × precio): la más limpia. omega ya la emite en su línea de
  métricas. Directa y comparable.
- **Eficiencia**: pasos/turnos del loop, tool calls, y tokens totales hasta
  completar. Esto sí mide al modelo —qué tan económica es su trayectoria— y es
  estable entre corridas.
- **Velocidad**: cuidado. El wall-clock por OpenRouter mezcla la velocidad del
  modelo con la latencia del provider, el routing y el overhead del harness. Es
  ruidoso y no aísla "el modelo". **tokens/pasos es una proxy de eficiencia más
  honesta que los segundos.** Si medís tiempo, sabé que es del proveedor tanto
  como del modelo.

## Metodología (lo que casi todos se olvidan)

### Estocasticidad → correr N veces

Las corridas agénticas son estocásticas: el mismo modelo en la misma tarea a veces
la saca y a veces no. **Una sola corrida no dice nada.** Hay que correr cada tarea
**k veces por modelo** (3–5 para empezar) y reportar:

- **tasa de éxito** (cuántas de k pasaron), no un booleano.
- **distribución** de costo/tiempo/pasos (mediana + dispersión), no un número
  único.

Comparar modelos con n=1 lleva a conclusiones falsas.

### Controlar los confounds

Mismo prompt, mismas tools, mismo system prompt, mismo `max_steps` / `max_tokens`
para todos. **Lo único que varía es el `model`.** Si no, no estás midiendo el
modelo, estás midiendo tu setup.

## Taxonomía de tareas (las "varias use cases")

Mapeadas a cómo se usa omega de verdad:

- **Bug fix**: test que falla → hacerlo pasar. El más limpio de verificar.
- **Feature nueva**: implementar a spec, verificada por tests.
- **Refactor**: preservar comportamiento — tests siguen verdes (+ quizás un
  chequeo estructural).
- **Cambio multi-archivo**: toca varios archivos → mide navegación y blast radius.
- **Read-heavy / "encontrá dónde se maneja X"**: verificable esperando un
  archivo/función específica en la respuesta.

Estos cinco cubren bien el espectro.

## Construir vs robar

No armes SWE-bench. Dos caminos:

- **Suite propia mínima**: un repo chico que escribís vos (un CLI, un parser, una
  TODO app) con bugs y features plantados, cada uno con su script de chequeo.
  Máximo control, entendés cada caso. Muy en el espíritu de omega.
- **Robar uno hecho**: el **benchmark de Aider** (ejercicios de Exercism con
  tests, multi-lenguaje) tiene exactamente la forma "repo + tareas + verificador"
  y se puede apuntar a omega con poco pegamento. **SWE-bench-lite** si querés
  tareas reales de GitHub, pero es pesado y Python-céntrico.

## Lo que omega necesita para esto — dos cosas

### 1. Modo headless

Hoy omega es interactivo (TUI). Para benchmarkear hay que correrlo no-interactivo:

```
prompt de entrada → corre hasta terminar → emite JSON
{ success?, cost, tokens, steps, toolCalls, durationMs, model }
```

Casi todo eso ya se trackea en las métricas; falta exponerlo **en máquina** (JSON
a stdout o a un archivo), no en la línea linda del TUI. El `success` lo setea el
harness al correr el chequeo, no omega.

### 2. El harness de corrida

Por cada `(tarea, modelo, repetición)`:

1. **Resetear el repo al checkpoint** (git clean/reset) — *no negociable*; el
   estado sucio de una corrida contamina la siguiente.
2. Correr omega headless con ese modelo sobre el prompt de la tarea.
3. Correr el script de chequeo de la tarea → pass/fail.
4. Registrar la fila: tarea, modelo, repetición, éxito, costo, tokens, pasos,
   tiempo.

Salida: una tabla (CSV/planilla) que después agregás por (tarea, modelo) en tasa de
éxito + medianas.

## Plan de arranque (chico)

- 3–5 tareas, repo propio.
- k = 3 corridas por (tarea, modelo).
- 2–3 modelos.
- Una planilla de resultados.

Crecés la suite a medida que encontrás failure modes interesantes — que es, de
paso, la mejor forma de descubrir qué mejorar en omega.

## Decisiones abiertas

- **¿Suite propia o Aider/Exercism?** Propia = más control y aprendizaje; Aider =
  no construís el verificador desde cero.
- **¿Qué optimizás?** Costo a igualdad de correctitud, o correctitud cruda. Esto
  cambia qué tareas conviene priorizar.
- **¿Dónde corre el headless?** Local vs contenedor (aislamiento real para el
  `bash` del agente durante las corridas).
