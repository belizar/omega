# Diseño: Guide — review persistente, anclada a git, con lentes y diagramas

> La Guide deja de ser un resumen efímero en memoria del browser y se vuelve un
> **artefacto de review**: persistido en disco, anclado al *conjunto de cambios*
> (no a un commit), customizable por una **lente** (un prompt libre), y capaz de
> emitir **diagramas** (secuencia, dominio) renderizados en la web.

## 0. Por qué / qué cambia

Hoy `generateReview(diff)` produce un `ReviewGuide {steps, base}` que vive solo en
`guides[sessionId]` en memoria del cliente. Recargás el browser o reiniciás el
daemon → se perdió, y regenerarla gasta otra llamada al LLM. Además es siempre la
misma review "general": no hay forma de pedirla desde un ángulo, ni de acompañarla
con un diagrama.

Tres cambios, que se componen:

1. **Persistencia + anclaje a git** — la review se guarda y sabe *de qué cambios
   es*, así al reabrir te dice si sigue vigente.
2. **Lente** — un prompt libre que enfoca la review ("desde DDD", "desde la web").
3. **Diagramas** — mermaid opcional (secuencia principalmente), que el web-client
   ya sabe renderizar.

Es el mismo modelo que el resto del cockpit: *un backend que proyecta el workspace
+ el two-pane que lo pinta* (ver `mission-control`). La Guide gana estado.

## 1. Anclaje a git — por **fingerprint de contenido**, no por SHA

La identidad de una review es **el conjunto de cambios que revisó**, no un commit
puntual. Si ancláramos por `HEAD` SHA, cada commit invalidaría la review — frágil,
y castiga el flujo real (revisás, commiteás, la review "muere" sin cambiar nada).

En cambio anclamos por **fingerprint del diff**: un hash estable de
`base + [{path, status, additions, deletions, patch}]` ordenado. Consecuencia:

- Commitear/pushear tu trabajo **no invalida** la review (mismos cambios → mismo
  fingerprint → sigue vigente). Exactamente lo que querés.
- El `headSha` se guarda como **metadato de display** ("vs `main`, en `a3f21c`"),
  no como identidad.
- Al abrir el tab: computo el fingerprint del diff actual y lo comparo con el
  guardado → **"vigente"** o **"⚠ el código cambió desde esta review"**. Eso es lo
  que hace el versionado *útil* — no una pila de JSONs sin saber cuál es cuál.

Caso sucio (cambios sin commitear, el más común: revisás *antes* de commitear): no
hay SHA, y no importa — el fingerprint es de contenido, anda igual.

## 2. Lente — un **prompt libre** (MVP)

Una lente es *la review desde un punto de vista*. MVP: **una caja de texto** en la
barra del tab Guide donde escribís el ángulo:

- vacío → review general (lo de hoy).
- `"desde el punto de vista DDD"` → agregados, invariantes, lenguaje ubicuo.
- `"desde la web: routing, data-fetching, a11y"` → lo que vos quieras.

El texto se **appendea al system prompt** como instrucción de enfoque, y se
**guarda con la review** → la identidad pasa a ser `(base, fingerprint, lente)`.
Para un **mismo diff** podés tener la review general *y* la DDD *y* la web, cada una
persistida, y el tab cambia entre ellas.

> **Futuro (no-MVP):** lentes con nombre reutilizables en `.omega/lenses/*.md`
> (proyecto + global), reusando el patrón de slash-commands/skills. El MVP de
> caja-de-texto ya deja el eje montado; los presets son azúcar encima.

## 3. Diagramas — mermaid opt-in, emitido por la lente

Golosina: **el web-client ya carga mermaid** (para el markdown). Así que los
diagramas son casi gratis:

- Un toggle **"incluir diagramas"** en la generación (opt-in: cuestan tokens y no
  siempre ayudan).
- El LLM emite bloques mermaid en un campo `diagrams[]` del JSON: secuencia (flujo
  de un request), class/ER (modelo de dominio — ideal para la lente DDD), flowchart
  (lógica).
- El panel Guide los renderiza con la integración mermaid que ya existe.

La lente **sugiere el tipo**: DDD → diagrama de dominio; general → secuencia. Se
unifica: una lente es *ángulo del prompt + diagramas que prefiere*.

## 4. Modelo de datos

```ts
interface ReviewGuide {
  base: string | null;        // vs qué (null = sin commitear)
  headSha: string | null;     // commit actual, solo display
  fingerprint: string;        // hash del diff → identidad + staleness
  lens: string;               // "" (general) | el prompt libre
  createdAt: number;
  steps: ReviewStep[];        // { title, rationale, files }
  diagrams: ReviewDiagram[];  // { title, kind, mermaid }  (puede ser [])
}
interface ReviewDiagram { title: string; kind: "sequence" | "class" | "flow" | "state"; mermaid: string; }
```

El modelo contempla las tres capas **desde la fase 1** (guardo `lens` y `diagrams`
aunque al principio sean `""` y `[]`), así no migramos después.

## 5. Backend

Store per-worktree (igual que los transcripts; el daemon lo lee por `cwdOf`,
consistente con Diff/Files): `<cwd>/.omega/reviews/<hash(base|fingerprint|lens)>.json`,
un archivo por review + el daemon los lista (como lista sesiones).

| Endpoint | Qué |
|----------|-----|
| `POST /review` | body `{ base?, lens?, diagrams? }` → computa diff + fingerprint, genera, **persiste**, devuelve el `ReviewGuide`. |
| `GET /reviews` | lista las reviews de la sesión (metadata + contenido; son chicas) + el **fingerprint del diff actual**, para que el cliente marque vigente/stale. |

`workspace/review-store.ts` (nuevo): `save`, `list`, `fingerprint(diff)`. `review.ts`
sigue generando; el store lo envuelve. `serve-mode` persiste en el `POST /review`
que ya existe (envuelto en `beginBackgroundTask`/`endBackgroundTask`).

## 6. UI — tab Guide

- **Barra**: input `base` (existe) · **textarea de lente** ("¿desde qué ángulo?
  vacío = general") · toggle **"incluir diagramas"** · botón generar.
- **Lista de versiones** (panel izquierdo, donde hoy van los pasos): las reviews
  guardadas de la sesión, cada una con lente · `base→head` · fecha · badge
  **vigente / ⚠ vieja**. Click para verla.
- **Detalle**: los pasos con sus diffs inline (como hoy) + los diagramas mermaid
  renderizados. Estado por-sesión (como `guides[]` hoy), pero hidratado del disco.

## 7. Roadmap (incremental, pero diseñado junto)

1. **Fundación** — `review-store` + fingerprint + persistencia + staleness. Resuelve
   el dolor original: no se pierde, sabés si está vigente. (Lente `""`, diagramas `[]`.)
2. **Lente** — textarea → prompt de enfoque; multi-lente por diff; lista de versiones.
3. **Diagramas** — toggle + prompt por lente + render mermaid en el detalle.

Cada fase es usable sola; el modelo de datos ya las contempla.

## Decisiones tomadas

1. **Identidad por fingerprint de contenido**, no por SHA — commitear no invalida.
2. **Lente = caja de texto libre** (MVP); presets `.omega/lenses/` quedan para después.
3. **Diagramas opt-in** (toggle), guiados por la lente, mermaid ya disponible.

## Conecta con

- `mission-control` — el cockpit / shell de tabs donde crece.
- `markdown-rendering-design` — mermaid ya integrado en el web-client.
- `slash-and-skills` — el patrón que reusarían las lentes con nombre (futuro).
- `omega-slash-and-skills`, `.omega/` como convención de extensibilidad por-proyecto.
