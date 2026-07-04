# 0007 — Progressive disclosure de tools vía `tool_search` + MCP lazy

- **Status:** accepted
- **Date:** 2026-07-04 _(backfill)_
- **Deciders:** Benjamin (+ Claude)

## Contexto

Cada servidor MCP puede aportar decenas de tools. Inyectar todos los schemas en
el system prompt infla el contexto (tokens y ruido) y degrada la elección de
tool del modelo, aunque el 90% no se use nunca en una sesión.

## Decisión

El modelo recibe **pocas tools esenciales eager** (read, write, edit, bash,
grep, outline, ask_user, tool_search). Una meta-tool **`tool_search`** busca
tools adicionales **bajo demanda** y las registra en el `ToolRegistry` para el
resto de la sesión; los servidores MCP **conectan lazy** (no hasta que se los
busca). `tool_search` devuelve nombre+descripción, no el schema — este se
materializa recién cuando la tool se invoca. (Ver `docs/design/mcp-progressive-disclosure.md`.)

## Consecuencias

- System prompt chico y estable independientemente de cuántos MCP haya
  configurados.
- **Costo:** el modelo tiene que *descubrir* tools; por eso el system prompt lo
  empuja a usar `tool_search` proactivamente cuando el usuario menciona un
  servicio externo.
- Base natural para governance multi-tenant (el "shelf": qué tools ve cada
  tenant es un cambio de registry, no de deploy). Ver `docs/design/shelf-capabilities-design.md`.
