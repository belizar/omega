# Diseño: watch / monitoring en omega

> Cómo omega pasa de one-shot (input → turno → fin) a poder **vigilar algo del
> mundo real** (un deploy, CI, logs, un endpoint) y reaccionar. Caso guía:
> *"desplegué una feature, tené un ojo en los error logs 30 min y avisame si
> algo aparece."*

## Principio central

**El loop de vigilancia es tonto y barato; el agente (caro) sólo se despierta
cuando algo se dispara.** No metemos el modelo en cada chequeo. Un monitoreo de
30 min son ~180 chequeos que cuestan casi nada (curl / query de logs + una
condición determinista), no 180 llamadas al modelo. El agente se activa sólo
ante un trigger.

Esto es el mismo patrón que ya usamos en el clasificador y el sidecar de visión:
un mecanismo barato y determinista adelante, el modelo caro atrás y sólo cuando
hace falta.

## Las cuatro piezas

1. **Check** — qué se corre en cada tick: un comando (`curl -s preview.app`,
   `gh run list`, `tail`) o una query MCP (Datadog / Supabase logs). Produce
   output + exit code.
2. **Condición** — cuándo se dispara:
   - *Determinista primero* (gratis): `contains "Error"`, `notContains`,
     `exitCode`, status HTTP, umbral numérico.
   - *Evaluador barato* sólo si es ambigua ("¿este log pinta sano?"): un modelo
     chico (Haiku), aparte del agente que trabaja. Nunca el primario.
3. **Cadencia + topes** — intervalo entre ticks, y **guards obligatorios**: tope
   de duración, de cantidad de checks, y de costo. Sin esto un monitor olvidado
   corre y quema plata (ver §Guards).
4. **Reacción** — qué pasa al dispararse: notificar al humano (alerta en el
   scrollback) y/o **kickear un turno del agente** inyectando el contexto del
   trigger (el log, el status) para que investigue.

## Arquitectura: dos capas, no un blob

Copiamos la separación de Claude Code, que resultó limpia:

- **Primitiva async (background task).** Correr un comando en background, que
  escribe su output a un archivo/stream, sin bloquear el REPL. Es el ladrillo.
  (CC: `run_in_background: true` + read del output; `/tasks` para listar/matar.)
- **Watch event-driven encima.** El monitor corre el check en background y
  **emite un evento por cada línea de stdout** (o por frame si es WebSocket). El
  agente reacciona por-evento **sin pausar la conversación**. Non-blocking desde
  el arranque — no una tool bloqueante que cuelga el turno.

Este es el ajuste clave respecto del boceto inicial: **apuntar directo a
event-driven no-bloqueante.** Es más difícil (hace falta una cola de eventos que
alimente/interrumpa al Runner), pero es el modelo correcto: el humano sigue
laburando mientras omega vigila.

## La parte peluda: la cola de eventos vs. el Runner y el editor fijo

La invariante de la TUI (ver `tui-design.md` §5) es que el editor vive fijo abajo
y todo va al scrollback vía `printAbove`. El monitor corre en background y sus
eventos llegan de forma asíncrona. Dos cosas a resolver:

1. **Los eventos del monitor van al scrollback vía `printAbove`**, nunca directo
   a stdout — igual que cualquier otro output. Una alerta del monitor es una
   línea `⚠` (yellow) en el scrollback, sobre el editor.
2. **Cuando un trigger tiene que despertar al agente**, el evento entra a una
   cola. Si el Runner está idle (esperando input), se inyecta como user message
   y se dispara `runTurn`. Si el Runner está en medio de un turno, el trigger
   espera en la cola hasta que el turno termine (no interrumpimos un turno en
   vuelo, salvo señal explícita). El monitor **no** compite por el editor: sólo
   empuja al scrollback y encola triggers.

Modelo mental: el monitor es un productor asíncrono; el REPL es el consumidor que
decide cuándo convertir un trigger en un turno.

## Guards (obligatorios, desde el día uno)

Robado de Claude Code, que los trata como ciudadanos de primera:

- **Tope de duración** (`--for 30m`) y/o **de checks** (`--max-checks N`).
- **Tope de costo** si hay evaluador de modelo (`--max-budget $`).
- **Auto-expiración**: un monitor sin tope explícito expira solo (CC expira los
  scheduled a los 7 días justamente para que no quede un loop olvidado).
- Todo monitor activo es **visible y matable** (`/watch list`, `/watch stop`).

## API propuesta

### v1 — tool `watch` (mecanismo, la que arranca)

El agente la llama dentro de un turno para esperas acotadas:

```
watch({
  command: "curl -s -o /dev/null -w '%{http_code}' https://preview.app",
  until:   { contains: "200" },        // o { notContains, exitCode, matches }
  intervalSec: 5,
  maxChecks: 60,                        // tope obligatorio
})
→ devuelve { triggered: true, checks: 8, lastOutput: "200" }
```

Caso: *"esperá a que el preview levante, después verificá la feature."* Reusa el
modelo de tools existente, cero concurrencia. Empezamos acá.

### v2 — `/watch` en background (el caso real de monitoreo)

Un monitor que vive fuera del turno, no bloquea:

```
/watch "tail -f logs" --alert-on "ERROR|panic" --for 30m
  → corre en background, emite eventos, alerta en el scrollback,
    y ante un match kickea un turno con la línea del log como contexto.
/watch list        → monitores activos
/watch stop <id>   → matar
```

Caso: *"desplegué, avisame si algo aparece en 30 min mientras sigo laburando."*
Es el que necesita la cola de eventos de arriba.

### Fuera de scope (proyecto aparte)

- **run-until-done / `/goal`**: el agente sigue solo hasta cumplir un objetivo,
  con evaluador separado + budgets (`max_turns`, `max_budget`). Distinto animal.
- **Scheduling / cron**: correr una tarea guardada en un horario. Infra aparte.

## Roadmap

1. `watch` tool con condiciones deterministas + `maxChecks`/timeout. (v1)
2. Condición vía evaluador Haiku para casos ambiguos (opt-in).
3. `/watch` background con cola de eventos + alertas en scrollback. (v2)
4. WebSocket además de polling, para streaming de logs en vivo.

## Referencias (cómo lo hace Claude Code)

- Background tasks: `run_in_background` + `/tasks`.
- Monitor tool (command-based / WebSocket, event-driven, non-blocking).
- `/goal` con evaluador separado (Haiku) + `max_turns` / `max_budget_usd`.
- Scheduled tasks con cron + auto-expiración a 7 días.

Docs: code.claude.com/docs/en/tools-reference · /goal · /agent-sdk/agent-loop ·
/scheduled-tasks
