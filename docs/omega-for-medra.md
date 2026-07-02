# Omega para Medra — norte del proyecto

> **Estado: ON HOLD, para otro branch.** Este es el doc paraguas del proyecto
> "Omega en la nube para Medra". No entra en detalle de cada pieza —cada una tiene
> su propio design doc— sino que las amarra y fija el norte para cuando se encare.

## Qué es

El CTO quiere omega corriendo **en la nube como coding agent autónomo**,
invocable desde Slack / GitHub, para el equipo de Medra. Esto es un **producto**
construido sobre el core de omega — no un fork de la herramienta personal.

Distinción de identidad (de `frontend-architecture-design.md`):
- **Omega** = core + TUI. La herramienta de craft de Benjamin. Liviana, local.
- **Omega para Medra (Cloud/Teams)** = un producto sobre el mismo core. Misma
  sangre, distinto cuerpo.

## Por qué es factible (el core ya está bien parado)

- El **Runner emite un stream de eventos** UI-agnóstico. La TUI es sólo un
  consumidor. Otro frontend = otro consumidor. Es el seam que habilita todo.
- Arquitectura **hexagonal (ports & adapters)**: el core es el hexágono; los
  frontends (puerto de entrada) y las tools/capabilities (puerto de salida) son
  adapters. Tanto "otra UI" como "otro producto" se vuelven "escribir un adapter
  / componer una app", no reescribir.

## Las piezas (cada una con su doc)

1. **Core como SDK + split de paquetes** — `frontend-architecture-design.md`.
   `packages/core` + adapters + `apps/omega-cli` vs `apps/omega-cloud`. El primer
   paso que desbloquea todo: extraer la orquestación de `index.ts` detrás de una
   interfaz `Frontend`, con la TUI como primera impl.

2. **Frontends** — `frontend-architecture-design.md`. Para Medra importan:
   **GitHub** (disparado por comment en PR/issue → responde como review comments),
   **Slack** (invocarlo, que comente en un canal), **HTTP/headless** (API,
   automatización). Todos consumen el mismo event stream.

3. **Loop autónomo + budgets** — `watch-monitoring-design.md`. Sin humano en el
   REPL, el agente necesita correr hasta terminar con presupuesto y criterio de
   parada (patrón `/goal` + `max_turns`/`max_budget`), decidir cuándo escalar, y
   monitorear (watch/condición). El 80% del esfuerzo real vive acá y en la infra.

4. **Hooks** — `hooks-design.md`. Notificaciones y automatización determinista en
   puntos de ciclo de vida. En la nube: notificar en Slack cuando un run necesita
   atención, correr checks post-tool, etc.

5. **Shelf (capabilities)** — `shelf-capabilities-design.md`. **Governance +
   multi-tenancy gratis:** cada tenant registra su shelf (MCPs/skills/commands
   aprobados). Dar/revocar una capacidad = un cambio en el registry, no un deploy
   del agente. El **proxy de registry** hace curaduría + auth + caché por tenant.

## Lo que es el trabajo de verdad (no subestimar)

Infra de nube — el 80% del esfuerzo, y es de producto, no de arquitectura:
- **Checkout del repo** en un sandbox por run.
- **Secretos** (tokens de GitHub/Slack/OpenRouter por tenant).
- **Identidad / auth** (¿quién dispara? ¿qué repo? ¿qué permisos?).
- **Concurrencia**: muchos runs a la vez → store de sesiones + workers/cola, no un
  proceso REPL con sesión en disco.
- **Multi-tenancy**: aislamiento de datos, memoria (cabinet) y shelf por tenant.

## Secuencia sugerida (cuando se encare)

1. **Seam refactor**: core como paquete detrás del puerto `Frontend` (días, no
   cambia comportamiento). Desbloquea todo.
2. **Frontend headless/HTTP** — el más barato, valida el seam, sirve para CI.
3. **Shelf v1** (MCP centralizado global) — ya útil en local, base para governance.
4. **Frontend GitHub** — el caso de uso más natural para un coding agent.
5. **Loop autónomo + budgets** — recién con lo anterior sólido.
6. **Infra de nube** (checkout, secretos, concurrencia, tenancy) — el proyecto
   pesado, en paralelo con 4-5.
7. **Slack + proxy de registry + governance** — la capa de producto/equipo.

## Norte

Un solo **core** (SDK). La TUI local y la nube de Medra son **composiciones** de
ese core con distintos adapters. Se extiende el core una vez; los productos son
apps encima. Nada de forks: el dolor de portar fixes dos veces (que ya sufrimos)
se evita manteniendo un solo corazón.

## Docs relacionados

- `frontend-architecture-design.md` — SDK, ports & adapters, split de paquetes.
- `watch-monitoring-design.md` — loop/monitoring, base del autónomo.
- `hooks-design.md` — hooks de ciclo de vida.
- `shelf-capabilities-design.md` — capabilities decoupleadas, governance.
- `session-summary-design.md`, `tui-design.md` — piezas de la herramienta local.
