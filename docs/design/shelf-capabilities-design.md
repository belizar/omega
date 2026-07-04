# Diseño: la shelf — capabilities decoupleadas del agente

> **Estado: ON HOLD.** Proyecto grande, va en otro branch. Este doc captura el
> modelo para retomarlo.

> Desacoplar al agente de las tools y de *dónde viven*. El agente consulta una
> **shelf** (estantería) de capabilities —local o remota— y agarra lo que
> necesita on-demand, en vez de tener las tools copiadas al lado.

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
  source }`. Es lo que se carga eager (barato) para el progressive disclosure.
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

1. Modelo interno `Capability` + `McpAdapter` (mover el MCP actual acá) +
   `shelf.json` global mergeado con proyecto → **mata el dolor del worktree.**
2. `SkillAdapter` (`SKILL.md` + `x-omega-*`) — adopta el formato portable.
3. `MarketplaceAdapter` (`marketplace.json`, repo git remoto) + `omega shelf add`.
4. Catálogo derivado + resolución perezosa con caché.
5. `OmegaNativeAdapter` (escape hatch) + proxy de registry (nube).
