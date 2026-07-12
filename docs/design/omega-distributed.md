# Diseño: omega distribuido — flota de agentes

> Cómo omega pasa de "un agente interactivo en mi laptop" a "una flota de agentes
> de distintos tipos, corriendo donde convenga, gobernada desde un solo panel" —
> sin romper el modelo, y sin volverse un agujero de seguridad.

## 0. Por qué (el encuadre, antes que la técnica)

Esto **no** es para competir con los grandes. Es **mi herramienta**, para **mi día
a día**, que **entiendo hasta el fondo**, corre en **mi infra**, y que **más
adelante quiero disponibilizar para mi equipo** (Medra).

El foso no es la cantidad de features — GitHub, OpenAI y Cognition ya tienen la
arquitectura distribuida, con plata y equipos. El foso es:

- **Self-hosted / own-your-runtime.** El daemon es mío, corre donde yo lo pongo.
  El código no se va a la nube de un tercero. Para Medra —código e infra propios—
  eso no es un detalle, es el punto.
- **Omega ES el agente, no un orquestador de agentes ajenos.** Es el agente + el
  runtime + el plano de control, una sola cosa coherente, un protocolo.
- **Es un proyecto de aprendizaje.** El objetivo es entender el stack y calzar el
  workflow exacto de Medra, no ganar SWE-bench.

Regla de oro: **en el momento que intente competir feature-a-feature con Agent HQ
o Devin, perdí.** Mientras sea el tool self-hosted que calza como un guante, gano
algo que ellos no dan. Ver [[omega-for-medra]].

## 1. Mapa competitivo (2026) — dónde encaja

El mercado convergió acá; que exista valida el problema y marca el vocabulario.

| Slice | Quiénes | Relación con omega |
|-------|---------|--------------------|
| **Plano de control sobre flota** | GitHub Agent HQ, Tembo | Es la mission-control con otro nombre ("un panel para asignar, monitorear, permisos, auditar") |
| **Distribución / sandboxes** | agentbox, Composio orchestrator, Conductor (yendo a la nube), cmux | La topología "N agentes, cada uno en su box, local o VM en la nube" |
| **Autónomos en la nube** | Devin, Codex Cloud, Cursor Background Agents, Jules, Claude Code Remote Tasks (mar-2026) | El modo "set-and-forget" |

**Diferencia de omega:** casi todos son **SaaS** (tu código va a su nube) o
**orquestadores de agentes ajenos** (shell-out a Claude Code/Codex). Omega es
self-hosted y es el agente mismo. Esa combinación no está commoditizada.

## 2. Tesis técnica

Cuando se partió el loop del frontend con un protocolo de red (HTTP/SSE), **"local"
pasó a ser un detalle de deployment**. La sesión —`{ loop, workspace (worktree),
transcript }`— vive entera en el **host donde corre el daemon**. El frontend nunca
tuvo el filesystem: solo el stream y el input. Por eso lo distribuido es barato: no
se cambia el modelo, se cambia el *target*.

El frontend es un **cliente de conexión**, como un cliente de base de datos: `psql`
no sabe si Postgres está en la laptop o en RDS — es una connection string. `local`
es sólo el target por defecto (`127.0.0.1:4477`).

## 3. Los tres ejes ortogonales

Lo que hoy está colapsado en "un agente interactivo, en mi laptop, que miro directo"
son en realidad **tres dimensiones independientes**:

| Eje | Pregunta | Valores |
|-----|----------|---------|
| **Modo** | ¿qué *tipo* de trabajo hace? | interactivo · autónomo · deep |
| **Ubicación** (target) | ¿*dónde* corre? | laptop · box en la nube · server de Medra |
| **Federación** | ¿cómo los veo a *todos*? | un panel único sobre N máquinas |

Son ortogonales: cualquier combinación es válida ("un agente **deep** en
**medra-box**, vigilado desde el **cockpit federado** de mi laptop"). Se construyen
**por separado**; el que los desbloquea a todos es el mismo: **targets + seguridad**.

El modo y la ubicación se atraen: **interactivo** quiere baja latencia (cerca mío);
**autónomo/deep** quiere compute pesado y correr horas sin que lo mire → nube, 24/7,
aunque la laptop duerma.

## 4. Eje UBICACIÓN — targets (el unlock)

- `~/.omega/targets.json`: `[{ name, url, token? }]`, con `local` implícito.
- `DaemonClient(port)` → `DaemonClient(baseUrl, token?)`. Ya existe `#host`; es
  generalizar a URL.
- Frontends: un picker **"conectar a…"** (SelectList en la TUI, dropdown en la web,
  `omega mc --target medra-box`).
- El índice (`~/.omega/index.json`) y los transcripts son **por daemon** (viven en
  el host). El cliente no los tiene: los pide. Hoy ya es así → remoto queda correcto
  sin tocar el modelo de persistencia.

**Superficie de código:** chica. `DaemonClient` toma baseUrl+token; los frontends
ganan un selector; `targets.json` en config.

## 5. Eje SEGURIDAD — el muro (y el diferenciador)

**El daemon es una superficie de ejecución de código** (corre `bash`/`edit`).
Tratarlo como `sshd`, no como una web app. Hoy bindea `127.0.0.1` sin auth **a
propósito**: exponerlo sin más es entregar un shell root a la red.

En un modelo self-hosted-distribuido, este riesgo es **mío** (no hay un SaaS que se
lo coma). Por eso la auth **no es burocracia: es lo que hace viable el self-hosted en
vez de temerario. Es feature, no deuda.**

### Escalera de transporte (barato+seguro → hosted)

1. **MVP: túnel SSH.** El daemon sigue en `127.0.0.1` en el host; `ssh -L
   4477:localhost:4477 host`. El target apunta a `localhost:4477` (tunelizado). SSH
   = auth + cifrado + no expone nada, auditado hace 30 años. Cero código de seguridad
   nuevo. Omega puede automatizar el `ssh -L` al "conectar".
2. **TLS nativo** (después): el daemon con HTTPS. Para browser remoto / sin SSH.

### AuthN / AuthZ

- **AuthN — bearer token por target.** El daemon exige `Authorization: Bearer <token>`
  en toda ruta (menos `/health`). Token generado por el daemon (`~/.omega/daemon-token`
  o `omega serve --token`). El cliente lo manda en cada request y en la SSE.
- **Bind explícito.** `--host 0.0.0.0` es opt-in consciente y loguea `⚠ expuesto`.
  Jamás por default.
- **Defense in depth.** El clasificador de bash (dos capas, ver `adr/0006`) sigue
  gateando comandos remoto — pero **no sustituye la auth** (auth primero).

### Multi-tenant — el norte del "equipo"

Hoy: *un token = un dueño, acceso total* (single-owner). Cuando disponibilice omega
al equipo de Medra, esto evoluciona a **identidades por usuario + AuthZ** (quién ve
qué sesiones, quién puede correr qué en qué máquina, auditoría). Es la "capa de nube"
real y el motivo por el que la auth se diseña con este norte desde el principio,
aunque el MVP sea single-owner. Ver [[omega-production-goal]].

## 6. Eje MODO — autónomo / deep (ortogonal, cuerpo de trabajo aparte)

Omega hoy es **sólo interactivo** (el loop espera tu input entre turnos). Los otros
modos son un feature en sí, independiente de lo distribuido:

- **Autónomo:** dado un objetivo, corre a completarlo sin esperar input; reporta
  progreso (y usa `ask-user`/notificaciones sólo cuando se traba). El loop no bloquea
  en `nextInput`.
- **Deep:** largo horizonte — planificación + subagentes + más herramientas, corre
  horas. (Conecta con el "Agent Modes" de Conductor y con `hooks-design`.)

Se modela como **metadata de sesión (`mode`) + variantes del loop**. No requiere nada
de lo distribuido, pero es donde lo distribuido brilla (un deep de 3h no querés que
muera al cerrar la laptop → lanzarlo autónomo en la nube).

## 7. Eje FEDERACIÓN — el cockpit (v2)

El daemon **local** se conecta a varios daemons remotos y muestra **todas las
sesiones juntas** (un panel, N máquinas). Se implementa **reusando `DaemonClient`**:
el daemon federador es, por dentro, un cliente de cada remoto. `listAll` = merge de
locales + remotos; el input se rutea al remoto dueño.

**Por qué en el daemon y no en el frontend:** centraliza la lógica fea (mergear
listas, rutear, cachear, deduplicar) en un lugar, mantiene el frontend con una sola
conexión, y las conexiones a remotos viven aunque cierres la pestaña. Es el patrón
API-gateway/BFF adelante de microservicios.

**Cuándo vale:** sólo con **flota heterogénea** (agentes de varios tipos en varias
máquinas a la vez). Con un solo box remoto, la topología de target (cambiar de
conexión) alcanza. Por eso es v2, no MVP.

## 8. Roadmap

1. **Targets + `DaemonClient(url, token)` + seguridad** (túnel SSH → auth nativa).
   ← el unlock de todo lo demás.
2. **Modos de agente** (autónomo/deep). ← ortogonal, cuando se quiera.
3. **Federación** (el cockpit). ← cuando haya flota heterogénea.
4. **Multi-tenant / identidades.** ← cuando se disponibilice al equipo de Medra.

## Conecta con

- [[omega-mission-control]] — la base (daemon, protocolo, sidebar) sobre la que esto crece.
- [[omega-production-goal]] / `omega-for-medra` — el norte de producto (agente self-hosted para Medra).
- [[omega-conductor-reference]] — el referente visual; Conductor también va hacia la nube.
- `hooks-design`, `watch-monitoring-design`, `frontend-architecture-design` — piezas relacionadas.
