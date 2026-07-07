# Diseño: la shelf + el belt — capabilities decoupleadas del agente

> **Estado: ON HOLD.** Proyecto grande, va en otro branch. Este doc captura el
> modelo para retomarlo. **Actualizado 2026-07-07:** se agrega la capa **belt
> (loadout)** — el nivel de consumo que faltaba, y la razón por la que la shelf
> escala. Ver "El belt (loadout): la capa de consumo".

> Dos capas complementarias:
> - **Shelf** = *dónde viven* las capabilities. El agente consulta una estantería
>   —local o remota— y agarra lo que necesita on-demand, en vez de tenerlas
>   copiadas al lado.
> - **Belt** = *cuáles están equipadas ahora*. De todo el inventario, el subconjunto
>   acotado que entra en contexto esta sesión (límite = presupuesto de contexto).

## Problema

Cada worktree nuevo obliga a copiar el `mcp.json` a mano. Y MCPs, skills y slash
commands viven pegados al agente cuando en realidad son capacidades que podrían
vivir en otro lado y referenciarse.

## El modelo (qué es qué)

La confusión a evitar: **no son todos "lo mismo", pero son la misma familia.**

- **Tool** = el átomo. Una acción (verbo) que el agente llama. Unidad base.
- **Receta** = composición de tools + conocimiento/instrucciones. Se distingue
  por **quién la invoca**:
  - **Skill** = receta invocada por el **modelo** (decide por la descripción).
  - **Slash command** = receta invocada por el **humano** (la tipeás).
  - (Un skill es un command que se auto-dispara el agente; un command es un skill
    que disparás vos. Difieren solo en el *invoker*.)
- **MCP** = NO es un hermano de los anteriores. Es un **source/transporte**: de
  dónde salen las tools. Eje ortogonal (source: builtin | mcp | script | remote).

Dos matices: un skill puede ser pura receta de conocimiento (tools opcionales);
y no todo slash command es receta (algunos son código determinista, ej. `/model`).

## La comunidad ya hizo esto — adoptar, no reinventar

- **Registries de MCP:** mcp.so (~20k servers), Smithery (hosting + índice), el
  registry oficial de MCP (Anthropic + GitHub + PulseMCP + Microsoft).
- **Claude Code plugins + marketplaces:** un marketplace es un **repo git con un
  manifest**; un plugin empaqueta **skills + MCP + commands + hooks + agents**.
  Flujo: agregás un marketplace → browseás → instalás. Es *exactamente* la shelf.
- **`SKILL.md` se está volviendo formato portable cross-agent** (Claude Code,
  Codex, Gemini CLI, Cursor…).

Conclusión estratégica: **adoptar los formatos estándar** (MCP, `SKILL.md`,
`marketplace.json`) hace que omega enchufe a miles de skills / decenas de miles
de MCP servers gratis. Mismo principio que hooks/CMUX: **interop por espejar el
contrato.**

## Adopción + formato propio: sé un superset, no un fork

Se adopta el estándar como base y se **extiende aditivamente** con campos
namespaceados que los demás ignoran. Seguís compliant afuera, enriquecido adentro.

```yaml
# SKILL.md
---
name: pr-review
description: "Review estructurado de un PR"
# extras de omega — el resto de los agentes los ignoran
x-omega-invoker: model
x-omega-model: sonnet
x-omega-cost-hint: high
---
```

**Tres niveles de compromiso, elegís por caso:**
1. **Estándar puro** — un skill/MCP de la comunidad tal cual. Cero fricción.
2. **Superset** — estándar + tus `x-omega-*`. El sweet spot del 90%.
3. **Nativo** — formato 100% tuyo, para lo que no tiene equivalente estándar. El
   escape hatch.

## Arquitectura: ports & adapters (el puerto de tools)

Omega tiene un modelo interno de `Capability` (suyo). **Un adapter por formato**
traduce el estándar → el modelo interno:

- `McpAdapter`: server MCP → capabilities (vía `tools/list`).
- `SkillAdapter`: `SKILL.md` (+ lee `x-omega-*`) → capability.
- `MarketplaceAdapter`: `marketplace.json` → set de las anteriores.
- `OmegaNativeAdapter`: `.omega/shelf/*.yaml` → capability (el escape hatch).

Todos escupen el mismo `Capability` interno:

```
Capability {
  name, description,          // discovery (progressive disclosure)
  invoker: model | human | both,
  kind:    tool | recipe,
  source:  builtin | mcp | skill | command | native,
  resolve(): …                // lazy: trae el cuerpo/schema on-demand
}
```

El estándar es un adapter más; tu formato propio es otro. Nunca se mezclan en un
schema — se normalizan al modelo interno.

## La shelf: registry de sources + catálogo derivado

**Lo único que escribís** es el registro de sources (tipo + ref, local o remoto),
global para que valga en todos los worktrees:

```json
// ~/.omega/shelf.json  (global)
[
  { "type": "mcp",         "ref": "npx mcp-remote https://mcp.linear.app/sse" },
  { "type": "marketplace", "ref": "git:github.com/benja/omega-shelf" },
  { "type": "skills",      "ref": "~/.omega/skills" }
]
```

- **Catálogo (derivado, no escrito):** el registry recorre cada source por su
  discovery nativo y produce la lista plana de `{ name, description, invoker,
  source }`. Es lo que se cargaría para el progressive disclosure.
  ⚠️ **Matiz de escala:** "cargar el catálogo entero, eager" es barato con 10
  capabilities, NO con cientos. La respuesta es el **belt** (sección siguiente):
  el contexto no lleva el catálogo, lleva lo equipado.
- **Resolución perezosa + caché:** el cuerpo de cada capability se trae la primera
  vez que se usa y se cachea en `~/.omega/cache/`. Si el source remoto se cae,
  usás el caché. "Remoto" no cuesta latencia por turno ni te deja sin tools.

## UX

```
omega shelf add git:github.com/benja/omega-shelf   # poné algo en la estantería
omega shelf list                                    # mirá los lomos
# el agente "lo agarra de la estantería" cuando la descripción matchea
```

Guardar el **invoker** por capability es clave: el agente **no** se auto-dispara
los `invoker: human` (tus commands), y vos podés disparar recetas.

## El belt (loadout): la capa de consumo

> La shelf responde *dónde viven* las capabilities. El belt responde *cuáles
> están equipadas ahora*. Sin esta capa, la shelf no escala: meter el catálogo
> entero en contexto se vuelve caro y ruidoso apenas hay muchas capabilities.

**La metáfora (de Benja):** un harness es como la armadura/skin de un personaje.
No llevás *todo* tu inventario encima — tenés **slots limitados** y elegís qué
poderes equipar para la misión. Después swappeás.

- **Shelf** = la **armería**. Todo lo que poseés. Ilimitada. En disco/nube.
- **Belt / loadout** = lo **equipado** en esta sesión. Acotado. El límite real no
  es capricho: es el **presupuesto de contexto** (cada capability equipada paga
  tokens en cada turno).

Son **dos niveles de progressive disclosure**, no uno:

1. **Shelf → Belt (equipar):** de todo el inventario, qué queda *disponible* esta
   sesión. Acotado. Es la capa nueva.
2. **Belt → uso (desenfundar):** dentro del belt, el cuerpo de la capability se
   resuelve on-demand al invocarla (lo que ya hace `resolve()` / la tool `skill`).

**Insight clave:** el belt NO es un sistema nuevo. Es ponerle **presupuesto +
expulsión** al disclosure que ya existe (`tool_search` + `skill`). Hoy esas tools
descubren y cargan; les falta un límite de slots y *desequipar* lo que no se usa.

### Ejes de diseño (trade-offs)

**Quién equipa** (el invoker del *equip*, distinto del invoker de la capability):

| Modo | A favor | En contra |
|---|---|---|
| **Humano cura** (build de RPG) | Control total, costo predecible, ideal para evals | Rígido: si no equipaste lo necesario, el agente se traba |
| **Humano + agente pide swap** | Balance control/flexibilidad | Requiere protocolo "me falta X" (más piezas) |
| **Agente auto-swap** | Máxima autonomía | Costo por turno impredecible; riesgo de *thrashing* |

**Modelo de slots:**

| Modo | A favor | En contra |
|---|---|---|
| **Lista curada** (límite = budget de tokens) | Flexible, sin número mágico | El límite es invisible hasta reventar el contexto |
| **Slots duros (N)** | Forcing-function: hace el costo tangible | Arbitrario; molesto si N queda corto |
| **Híbrido** (budget + aviso) | Límite real y visible pero blando | Más para construir (estimar costo, avisar) |

### Relación con profiles (no es concepto nuevo suelto)

Omega ya tiene `AgentProfile` (hoy ≈ modelo + settings, con `/profile`). El belt
es el candidato natural a vivir *dentro* de un profile extendido:

> **profile = build = modelo + belt + settings.**

Se reusa `/profile list|<nombre>` y el merge global/proyecto que ya existe. Un
`activateProfile` equipa el belt de ese build.

### Conexión con las evals (Omega Interviews)

Un belt **es** una configuración de harness → un **candidato**. Distintos belts
son distintos builds que se pueden A/B testear con el harness de entrevistas. Para
Medra: roles distintos → belts curados y aprobados (governance vía el proxy de
registry). El "harness como armadura", literal y medible.

### Cuándo construirlo (honestidad YAGNI)

El valor del belt es **proporcional a `inventario × cambios de contexto`**. Hoy
Omega tiene ~8 tools esenciales + un puñado de skills que ya cargan barato → **no
hay nada que curar todavía**. Construir la armería antes de tener armas es
prematuro (por eso toda esta shelf está on-hold).

- **Trigger para construirlo:** escala Medra — decenas de skills/MCPs y varios
  roles, donde "todo siempre on" se vuelve caro *y* distrae al agente.
- **Beneficio que sí aplica hoy:** equipar no es solo tokens, también es **foco**.
  "Para esta tarea, solo estas 2 skills activas" mantiene al agente enfocado a
  cualquier escala. Esa es la **semilla barata**: un belt mínimo por profile
  (lista de skills/tools activas), forward-compatible con la shelf completa.

## Nube / governance: el proxy de registry

Para multi-tenancy: un **proxy de registry** propio entre omega y los registries
remotos, que hace **caché + auth + curaduría** ("en la cloud-omega de Medra solo
se ven *estos* MCPs/skills aprobados"). Desde omega es un adapter más. Governance
y multi-tenancy gratis. (Conecta con `omega-for-medra.md`.)

## Naming

**shelf** (capabilities) + **cabinet** (memoria) — mundo de muebles coherente.
`shelf.json`, `omega shelf add`. La shelf abajo es un marketplace; "shelf" es el
nombre de UX.

## Roadmap

**Ya shipeado (fuera de la shelf, leyendo `.omega/` directo):** slash commands
custom (#86), menú `/` de descubrimiento (#87), skills model-invoked (#88). Son
las *recetas* del modelo — la shelf después las va a normalizar al `Capability`
interno vía adapters, sin reescribir su UX.

**Shelf (sourcing / storage):**

1. Modelo interno `Capability` + `McpAdapter` (mover el MCP actual acá) +
   `shelf.json` global mergeado con proyecto → **mata el dolor del worktree.**
2. `SkillAdapter` (`SKILL.md` + `x-omega-*`) — envolver las skills de #88 en el
   modelo `Capability` (adoptar el formato portable formalmente).
3. `MarketplaceAdapter` (`marketplace.json`, repo git remoto) + `omega shelf add`.
4. Catálogo derivado + resolución perezosa con caché.
5. `OmegaNativeAdapter` (escape hatch) + proxy de registry (nube).

**Belt (consumo / equip) — se apoya en la shelf pero puede empezar antes:**

6. **Semilla:** belt mínimo por profile — lista de skills/tools activas
   (equip/unequip). Útil hoy por foco; no necesita la shelf completa.
7. **Belt completo:** presupuesto de slots + expulsión sobre el disclosure
   (`tool_search`/`skill`). Elegir ejes (quién equipa, modelo de slots) recién
   acá, con el problema real enfrente.
8. Belt como candidato en Omega Interviews: A/B de builds.
