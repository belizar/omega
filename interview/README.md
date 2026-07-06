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
