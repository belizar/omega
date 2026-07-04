# Architecture Decision Records

Registro de las decisiones arquitectónicas de Omega: **el porqué**, no el qué
(el código dice el qué). Cada ADR captura el contexto, la decisión y el precio
que se paga. Son inmutables — una decisión que cambia genera un ADR nuevo que
*supersede* al anterior.

Distinción con los otros artefactos:
- **`docs/design/`** = cómo *va a* funcionar algo (futuro).
- **issues de GitHub** = trabajo *a hacer* (presente).
- **`docs/adr/`** = decisiones *tomadas* y sus consecuencias (pasado con efecto).

Para uno nuevo: copiá [`TEMPLATE.md`](TEMPLATE.md), numeralo, y agregalo al índice.

## Índice

| # | Decisión | Status |
|---|---|---|
| [0001](0001-runner-event-stream-seam.md) | El Runner emite un event stream UI-agnóstico (seam hexagonal) | accepted |
| [0002](0002-single-core-sdk-sin-forks.md) | Un solo core como SDK, sin forks | accepted |
| [0003](0003-llm-provider-openrouter.md) | Abstracción `LLMProvider` + OpenRouter como primario | accepted |
| [0004](0004-tools-devuelven-string.md) | Las tools devuelven `string` y nunca lanzan | accepted |
| [0005](0005-contexto-turn-aware.md) | Poda de contexto turn-aware + compactación de reads rancios | accepted |
| [0006](0006-bash-seguridad-dos-capas.md) | Seguridad de bash en dos capas (hardblock + clasificador) | accepted |
| [0007](0007-progressive-disclosure-tools.md) | Progressive disclosure de tools vía `tool_search` + MCP lazy | accepted |
| [0008](0008-cabinet-memoria-largo-plazo.md) | Cabinet como memoria de largo plazo (por qué > qué, git-backed) | accepted |
