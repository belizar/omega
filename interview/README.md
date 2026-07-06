# Omega Interviews

**Evals agénticos** para omega, con marco de *entrevista de trabajo*. (Si venís
buscando "benchmark" o "eval de modelos": es esto.)

La metáfora no es decorativa — codifica la metodología correcta: entrevista
**estructurada** (mismas condiciones a todos), **multi-ronda** (no decidís con una
corrida), con **rúbrica objetiva** (no a ojo), y preguntas que **discriminan**.

## Vocabulario

| Término | Qué es |
|---|---|
| **candidate** | el modelo bajo evaluación (`--model`) |
| **question** | una tarea = `repo inicial + brief + rubric` |
| **brief** | el prompt que se le da al candidate |
| **rubric** | el chequeo objetivo que emite el verdict (script, no ojo) |
| **round** | una repetición (las corridas son estocásticas → k rondas) |
| **verdict** | pass / fail de una corrida |
| **transcript** | la fila registrada (verdict + costo, pasos, tokens) |

## Principios (del diseño)

1. **El eje cero es correctitud.** Costo/pasos/tiempo solo cuentan *entre las
   corridas que pasaron*. Un modelo barato que entrega mal no vale nada.
2. **N rondas, no una.** Las corridas agénticas son estocásticas. Se reporta
   **tasa de éxito** + **medianas**, no un booleano.
3. **Controlá los confounds.** Mismo brief, tools, system prompt, límites para
   todos: lo único que varía es el `candidate`. Si no, medís tu setup, no el modelo.
4. **El costo es una feature.** `--budget` corta antes de pasarse del gasto.

## Correr

```bash
npm run build   # el interviewer usa dist/index.js

node interview/run.mjs \
  --models deepseek/deepseek-v4-pro \   # candidates (coma-separados)
  --k 1 \                               # rondas por (question, candidate)
  --budget 0.50 \                       # corta antes de pasarse ($)
  --question demo-bugfix                # opcional; default: todas
```

Salida: una fila por corrida (transcript), la agregación por `(question,
candidate)` en éxito + medianas, y un CSV en `interview/results/`.

## El objetivo: mejorar el harness (no elegir un modelo)

La JD de omega es **mejorar el propio harness**. Eso cambia el eval:

- **La variable es omega, no el modelo.** Congelás un modelo barato (el mismo para
  todo) y movés el *diseño de omega*. Si movés el modelo, medís el modelo, no tu
  cambio.
- **Es un A/B de regresión:** corrés, tocás algo de omega, re-corrés, comparás.
  `--omega <path>` apunta a builds distintos; `--label` etiqueta cada corrida.
- **Las questions tienen que ser sensibles al harness:** navegación multi-archivo,
  multi-paso con recuperación. Un fix trivial no mueve la aguja.
- **La señal vive en la trayectoria.** Con el modelo congelado la correctitud
  satura; un mejor harness llega a lo mismo con **menos re-lecturas, menos
  tool-errors, menos pasos**. Por eso esas columnas están en la tabla.

```bash
# A/B: misma question, mismo candidate, dos versiones de omega
node interview/run.mjs --models deepseek/deepseek-v4-pro --k 3 --label antes \
  --omega /ruta/a/omega-viejo/dist/index.js
# … cambiás algo de omega, npm run build …
node interview/run.mjs --models deepseek/deepseek-v4-pro --k 3 --label despues
# comparás los dos CSV en interview/results/
```

## Questions actuales

| question | tipo | qué estresa |
|---|---|---|
| `demo-bugfix` | trivial | smoke — prueba la máquina, no discrimina |
| `nav-negatives` | bug de navegación | síntoma en `index.mjs`, causa en `tokenize.mjs` (2 hops) → search/read/context |
| `feat-mode` | feature multi-archivo | agregar un stat siguiendo el patrón → navegación + comprensión |

## Agregar una question

```
interview/questions/<nombre>/
  repo/         # estado inicial; se copia a un workdir temporal por corrida
  brief.md      # el prompt para el candidate
  rubric.mjs    # recibe <workdir>, exit 0 = pass. VIVE FUERA DE repo/
                # (el candidate no la ve: como el test escondido de SWE-bench)
```

Una buena question **discrimina**: si todos los candidates la pasan (o todos la
fallan), no separa. Las valiosas son donde los modelos disienten — se descubren
corriendo, y cada una es un failure mode que te dice qué mejorar en omega.
