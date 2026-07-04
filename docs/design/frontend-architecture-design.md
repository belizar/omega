# Diseño: omega como SDK multi-frontend (ports & adapters)

> **Estado: ON HOLD.** Es un proyecto grande y aparte. Este doc captura la
> decisión arquitectónica para retomarla cuando haya apetito (empuje del CTO
> hacia "omega en la nube", o ganas de un frontend Slack/GitHub).

## El disparador

El CTO quiere que omega corra en la nube como coding agent autónomo. Y hay otros
frontends deseables: invocarlo desde Slack, que comente en un canal, que
responda una consulta puntual. La pregunta: ¿estamos lejos? ¿es otro omega?

## La observación central (por qué el core ya está bien parado)

**El `Runner` no dibuja nada.** Corre el loop agéntico y emite un stream de
eventos (`text_stream`, `tool_use`, `tool_result`, `state`, `ask_user`). La TUI
es apenas el *consumidor* de ese stream. Ese stream **es el seam** que habilita
otros frontends: una UI nueva es "consumir los mismos eventos distinto". La
decisión difícil ya está tomada bien.

Lo que NO está pagado todavía: `index.ts main()` fusiona orquestación con I/O de
terminal (raw mode, `LineEditor`, `Screen`), y los comandos asumen `ctx.screen`.
La lógica "input → correr → eventos" no está separada del "leer teclado / dibujar".

## Arquitectura objetivo: hexagonal (ports & adapters)

El core es el hexágono. Todo lo demás son adapters enchufados en dos puertos:

- **Puerto de entrada (driving) — Frontends:** cómo se maneja al agente.
  Interfaz `Frontend { render(event), getInput(), askUser(question) }`. La TUI
  es la primera implementación.
- **Puerto de salida (driven) — Tools & Providers:** qué alcanza el agente.
  `Tool` + `ToolRegistry` + **MCP** (ya existe: "agregá tools que no escribiste")
  + el `LLMProvider`.

El trabajo de extensibilidad es **formalizar el puerto de frontends** — el mismo
seam-refactor. El puerto de tools ya existe y funciona (MCP incluido).

## Omega como SDK

`packages/core` importable = un **SDK: el motor de agente como librería.**

- **Driving:** el consumidor recibe el stream de eventos + provee input/askUser
  → escribe un adapter `Frontend`.
- **Driven:** registra tools (propias o MCP) y el provider.
- **Distribución = composición:** el mismo SDK compuesto en apps distintas
  (CLI local, servicio de nube, bot de Slack, GitHub Action, MCP server). La
  distribución es cómo se empaqueta y corre; el SDK es el corazón compartido.

Es el modelo del Claude Agent SDK. Caveat: volverlo un SDK "de verdad" sube la
vara (estabilidad de API, versionado del surface público de `core`). Para una
herramienta personal es overkill; la disciplina de SDK importa recién como
producto.

## Frontends candidatos

| Frontend | Notas |
|----------|-------|
| **TUI** | El actual. Primera impl del puerto. |
| **Headless CLI** (`omega -p`) | Prompt → JSON/stdout. CI y scripts. Casi gratis con el seam. |
| **HTTP/WebSocket** | Habilita web UI o llamadas programáticas. |
| **GitHub/GitLab** | Disparado por comment en PR/issue, responde como review comments. El más natural para un coding agent. |
| **Slack / Discord / Teams** | Mismo adapter, distinto SDK de chat. |
| **Editor** (VS Code / JetBrains) | Omega como backend, editor como frontend. |
| **Email** | Responder una consulta puntual. |
| **Event-driven / sin UI** | Webhook o cron (CI falló → omega investiga). El caso autónomo puro. |
| **Omega como MCP server** | La inversión: exponer omega *como tool* que otros agentes llaman. |

## Selección de frontend por config

Campo `frontend` en `.omega/config.json` o `OMEGA_FRONTEND=tui|slack|http|headless`,
elegido en el setup, + la config específica del adapter (tokens de Slack, puerto
HTTP). Encaja en el sistema de perfiles existente.

## Extender vs. fork: ni uno ni el otro

El **fork es la herramienta equivocada**: el core se mejora todos los días; un
fork diverge el día uno y cada fix hay que portarlo dos veces (el dolor de las
regresiones, ×2 repos).

Pero "cloud omega es otra cosa" **también es cierto**: multi-tenancy, auth,
secretos, concurrencia, hosting son concerns distintos que ensuciarían el
daily-driver.

Resolución: **separar en el límite de paquete, no en el de repo.**

```
omega/ (monorepo, un solo core)
├── packages/core            ← Runner, tools, session, agent-loop (el corazón)
├── packages/frontend-tui    ← la TUI actual (adapter)
├── packages/frontend-slack  ← adapter
├── packages/frontend-http   ← adapter
├── apps/omega-cli           ← compone core + tui (la herramienta de siempre, liviana)
└── apps/omega-cloud         ← compone core + http/slack + infra de nube
```

"Omega Teams" no es un fork, es una **app nueva sobre el mismo core**. Se extiende
el core una vez; los productos son composiciones. La CLI local queda liviana
porque la infra de nube vive solo en `omega-cloud`, fuera de su árbol de deps.

**No hay que decidir el tema producto ahora:** extraer el core (que igual
conviene por el seam) permite seguir disfrutando la TUI, y si algún día se quiere
la nube, es una app encima, no una reescritura ni una contaminación.

Naming: **Omega** = core + TUI (proyecto de craft). **Omega Cloud/Teams** =
producto sobre el core. Misma sangre, distinto cuerpo.

## Lo que sí es el trabajo de verdad (no es "una UI")

- **Loop autónomo:** correr solo hasta terminar, con presupuesto y criterio de
  parada (el `/goal` + budgets del análisis de Claude Code, ver
  `watch-monitoring-design.md`). Sin humano en el REPL, decidir cuándo terminó /
  escala / pide ayuda. Engancha con la orquestación multi-sesión parkeada.
- **Infra de nube:** checkout del repo en sandbox, secretos, identidad (¿quién
  pregunta? ¿qué repo? ¿qué permisos?), concurrencia (store de sesiones +
  workers/cola en vez de un proceso REPL con sesión en disco).

Esto es el 80% del esfuerzo, y es de producto/infra, no de arquitectura mal
parada.

## El primer paso (cuando se retome)

**Extraer la orquestación de `main()` detrás de la interfaz `Frontend`, con la
TUI como primera impl.** Puro refactor interno, no cambia comportamiento, y
convierte tanto "otra UI" como "otro producto" en "escribir un adapter / componer
una app". Es lo que desbloquea todo lo demás.

## ¿Muy lejos?

- Conceptualmente: no. El núcleo (Runner + event stream + tools + session) ya es
  UI-agnóstico.
- El seam-refactor: días. Desbloquea headless y Slack rápido.
- Loop autónomo + infra de nube: semanas. El proyecto real.
