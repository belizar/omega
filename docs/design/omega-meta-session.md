# Diseño: meta-sesión — Omega mejorándose a sí mismo

> Una sesión donde un modelo fuerte, con acceso al corpus de sesiones reales de
> Omega, ayuda a iterar el **system prompt** de Omega — con evidencia de las
> trazas, no de opiniones. Omega mejorándose a sí mismo, revisado en su propia
> cabina.

## 0. La idea

Omega viene generando, sin querer, un **corpus de su propio comportamiento** (137
sesiones de trazas reales). El system prompt es la "política". Cada vez que el
usuario **corrige** a Omega ("no", "eso está mal", lo re-promptea) está etiquetando
un fallo de esa política. El loop: minar las correcciones → un modelo fuerte
propone edits al prompt con evidencia → el humano revisa y aplica. Es **RLHF-lite
de correcciones reales, pero como ediciones al prompt en vez de pesos.**

## 1. Qué es una meta-sesión

Una sesión de Omega con cuatro cosas especiales:

1. **Modelo fuerte** (Opus/GPT-class, vía `/model`) — es meta-análisis, querés el
   mejor razonador, no el modelo de trabajo diario.
2. **Acceso al corpus** — la tool `sessions` (`list`/`search`/`read`).
3. **Rol de "prompt doctor"** — el command `/improve-prompt` inyecta el encuadre.
4. **Corre en el worktree de omega** — así lee `src/system-prompt.ts` y, cuando
   acuerdan un cambio, lo edita. El humano lo revisa en la tab **Diff** y commitea.

`★ Insight`: de las 4, **solo una es nueva** (la tool `sessions`). Las otras tres
reusan lo que ya existe — modelo (`/model`), rol (slash command), revisión (Diff).

## 2. La tool `sessions` (el corazón)

Solo-lectura sobre el corpus (`~/.omega/index.json` + los transcripts):

| Acción | Qué |
|--------|-----|
| `list [project]` | lista sesiones (id corto · proyecto · título), recientes primero, filtrable por proyecto |
| `search <query> [project]` | busca texto en los transcripts → excerpts + sesión de origen |
| `read <id>` | el transcript aplanado de una sesión |

El agente **maneja la exploración** (agéntico) — por eso lo interactivo es lo
correcto: decide qué mirar, refina, sigue el hilo.

**Privacidad**: la tool **omite los outputs de las tools** (pueden traer secrets, y
no aportan a la señal). Ves user + assistant + qué tools se usaron — que es
justo donde vive la señal de comportamiento. Aun así, los transcripts van al
contexto del modelo fuerte (data afuera): tenerlo presente al elegir el modelo.

## 3. Curar el corpus

Muchas sesiones son **pruebas de funcionalidad**, no trabajo real → serían ruido.
Curación:

- **MVP (hoy)**: **conversacional** — el agente arranca preguntando qué proyectos
  son trabajo real vs pruebas; `sessions list` te muestra los proyectos; vos le
  decís en qué enfocarse y filtra por `project`. Flexible: refinás el corpus a
  mitad de charla.
- **v2**: un **picker visual** al lanzar (sesiones agrupadas por proyecto, checkboxes
  + "toda la carpeta"), que scopea la tool a un set de ids elegido. Explícito y
  reproducible.
- **v3**: **tag persistente** ("prueba" vs "trabajo") para que el picker pre-filtre.

## 4. El loop

```
charlás con el modelo fuerte
   → busca en tus sesiones (sessions search/read)
   → encuentra el patrón ("sos verboso; mirá estas 5 sesiones donde te corté")
   → propone { observación · sesiones que lo prueban · edit al prompt }
   → acuerdan → edita src/system-prompt.ts
   → lo revisás en la tab Diff → commiteás
```

## 5. Roadmap

1. **Tool `sessions` + command `/improve-prompt`** ← MVP (hecho). Curación conversacional.
2. **Picker de corpus** (visual, al lanzar).
3. **Tag de sesiones** (prueba/trabajo) + corpus persistente.
4. **Confluencia con `omega-interviews`** (evals sintéticos): interviews = "¿pasás
   los tests que inventé?"; meta-sesión = "¿qué me dice mi uso real?". Los dos
   alimentan el mismo prompt desde ángulos opuestos.

## Cómo usarla (MVP)

1. Nueva sesión **Attach** al worktree de omega (`~/Workspace/omega/master`).
2. `/model` → un modelo fuerte.
3. `/improve-prompt` → arranca el rol; te pregunta en qué enfocarte.
4. Charlás. Cuando propone un edit y te cierra, lo aplica a `system-prompt.ts`;
   revisás en Diff y commiteás.

## Conecta con

- `omega-context-hierarchy` — la sesión y su workspace.
- `omega-interviews` — el gemelo sintético (evals).
- `omega-guide-review` — mismo patrón (LLM enfocado sobre un corpus → estructura).
