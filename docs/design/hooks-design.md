# Diseño: hooks en omega

> Handlers deterministas que el usuario engancha a puntos de ciclo de vida del
> agente. Caso guía: **notificar cuando el agente necesita atención** (como los
> hooks de Claude Code que consume CMUX para avisar).

## Por qué encaja natural

Omega ya tiene la pieza clave: el **stream de eventos del Runner**
(`text`, `tool_use`, `tool_result`, `state`, `ask_user`) que el REPL consume.
Los hooks son, en esencia, dejar que el usuario **enganche comandos a esos
eventos**. El andamiaje de eventos ya existe; los hooks sólo los exponen.

Los hooks son **deterministas y ortogonales al loop del agente**: corren pase lo
que pase, sin depender de que el modelo decida nada. Igual que en Claude Code.

## Eventos (puntos de enganche)

| Evento | Cuándo | Payload extra |
|--------|--------|---------------|
| `session-start` | al arrancar omega | — |
| `pre-tool` | antes de ejecutar una tool | `toolName`, `toolInput` |
| `post-tool` | después de una tool | `toolName`, `toolInput`, `isError` |
| `turn-end` (stop) | el turno terminó, el agente espera al usuario | — |
| `ask-user` (notification) | el agente hace una pregunta a mitad de tarea | `question` |
| `error` | algo reventó en el turno | `message` |

Los dos de **atención** son `turn-end` y `ask-user` — ahí va la notificación.

**Dónde engancha cada uno:**
- `session-start`: en `index.ts` al boot.
- `pre-tool` / `post-tool`: en el REPL, cuando llega el evento `tool_use` /
  `tool_result` del Runner (con `matcher` por nombre de tool).
- `turn-end`: después de `runTurn`.
- `ask-user`: en el callback `onAskUser`.
- `error`: en el `catch` de `runTurn`.

## Configuración

`.omega/hooks.json` (o key `hooks` en `config.json`), mapeando evento →
lista de handlers:

```json
{
  "turn-end": [
    { "command": "osascript -e 'display notification \"omega terminó\" with title \"omega\"'" }
  ],
  "ask-user": [
    { "command": "terminal-notifier -message 'omega te necesita' -title omega" }
  ],
  "post-tool": [
    { "matcher": "edit", "command": "prettier --write \"$OMEGA_TOOL_PATH\"" }
  ]
}
```

- `command`: shell a ejecutar.
- `matcher` (opcional, sólo tool events): filtra por nombre de tool.

## Contrato: JSON por stdin

En cada evento, omega spawnea el/los comando(s) y le pasa un **JSON por stdin**:

```json
{
  "event": "ask-user",
  "sessionId": "e5235b6f-…",
  "cwd": "/Users/benja/…/medra-functions/main",
  "question": "¿Qué leads específicos?"
}
```

**Decisión: espejar el contrato de Claude Code** (mismos nombres de evento y
shape de JSON) donde se pueda. Así el setup de hooks de CMUX / cualquier tooling
del ecosistema funciona con omega casi sin tocar nada. Interop gratis.

## Decisiones de diseño

1. **No-bloqueante en v1.** Los hooks son fire-and-forget (spawn con timeout
   corto, no se espera el resultado). Suficiente para notificaciones, formateo,
   side-effects.
2. **Bloqueo diferido.** Claude Code permite que un `pre-tool` deniegue una tool
   (por exit code). En omega eso **se solapa con el clasificador** (que ya gatea
   bash). Se deja para después, y probablemente viva en el clasificador, no acá.
3. **Sólo command hooks en v1.** Shell commands dan el 80/20. Los hooks
   `prompt` / `agent` (que invocan un modelo) son avanzados → v2.
4. **Variables de entorno** además del stdin JSON, para comodidad en el shell:
   `OMEGA_EVENT`, `OMEGA_TOOL_NAME`, `OMEGA_TOOL_PATH`, `OMEGA_CWD`, etc.

## Atajo: bell / OSC para notificación

Si lo único que se quiere HOY es la notificación (no el sistema entero), omega
puede emitir un **bell (`\a`) o un escape OSC 9** cuando necesita atención;
muchos terminales (posiblemente CMUX) disparan una notificación nativa con eso,
sin configurar ningún hook. Es ~5 líneas. El sistema de hooks es la solución
general; el bell es el parche inmediato para *este* dolor.

## Arquitectura

Una clase `HookRunner`:
- `constructor(hooksConfig)` — carga `.omega/hooks.json`.
- `fire(event, payload)` — busca handlers del evento, filtra por `matcher`,
  spawnea cada `command` con el JSON en stdin + las env vars, no bloquea.

Se instancia en `index.ts` y se llama `hooks.fire(...)` en los puntos de
enganche. Relación con el resto: es un **observador del stream de eventos**, en
la misma línea que el diseño de watch/monitoring y el de frontends (el core
emite eventos; hooks, frontends y monitores son consumidores).

## Roadmap

1. `HookRunner` + `session-start`, `turn-end`, `ask-user` (la notificación ya).
2. `pre-tool` / `post-tool` con `matcher` + env vars.
3. `error`.
4. (v2) hooks bloqueantes, hooks `prompt` / `agent`.
