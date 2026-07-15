# Diseño: jerarquía de contexto — Project · Workspace · Session

> El daemon multi-sesión necesita UN modelo claro de *dónde vive la config y quién
> la resuelve*. La respuesta: una jerarquía de contención **ProjectContext (1 por
> repo) → WorkspaceContext (N) → Session (N)**, más capas de config ortogonales
> **User · Team · Project** que se superponen. Raíz del fix del cwd (MCP, skills,
> commands) y fundación para el mundo Medra (equipo) y el distribuido.

## 0. El problema

omega nació **modelo TUI**: corrés `omega` DENTRO del proyecto → `process.cwd()` =
el worktree → todo (`.omega/mcp.json`, skills, commands, AGENT.md) resuelve bien.

El **daemon rompe eso**: se lanza desde un lugar (`~/Workspace`, o `/` cuando lo
spawnea la app) y hospeda N sesiones, cada una en OTRO worktree. Cualquier loader
que use `process.cwd()` mira el cwd de arranque, **no** el worktree de la sesión.
Síntoma real: los MCPs configurados no aparecían (el agente hacía `tool_search` y
no encontraba nada) — ver PR #116. Y lo mismo pasa con skills y slash commands.

No es "el daemon hace demasiado". Es que la noción de *"el proyecto de esta sesión"*
estaba **implícita y dispersa** (`process.cwd()` por default en cada loader) en vez
de ser **un objeto explícito**.

## 1. La jerarquía (contención)

```
ProjectContext        (1 por repo)
  └─ WorkspaceContext  (1..N)   un repo, muchos worktrees (main, feat/MED-x, …)
       └─ Session       (1..N)   un worktree, una o varias conversaciones
```

Cada nivel es dueño de algo distinto — por eso NO colapsa en un objeto plano:

| Nivel | Cardinalidad | De qué es dueño |
|-------|--------------|-----------------|
| **ProjectContext** | 1 por repo | Config **compartida del repo**: MCPs, lenses, commands/skills versionados, convenciones (AGENT.md). Resuelto una vez, lo comparten sus N worktrees. |
| **WorkspaceContext** | N por project | Lo **concreto y mutable**: cwd, `projectRoot` (git-root), branch, git-state, el diff, las reviews. Referencia a su ProjectContext. |
| **Session** | N por workspace | La **conversación**: transcript, agentConfig, el loop, el hub del frontend. Referencia a su WorkspaceContext. |

El `1..N` de **Workspace → Session** hoy es casi siempre `1:1`, pero el modelo lo
deja abierto a propósito (dos conversaciones sobre el mismo worktree: una haciendo
el feature, otra investigando un bug). Decisión de producto, gratis en el modelo.

## 2. Contención ≠ capas de config

Punto clave para no meter secrets en un repo:

- El árbol `Project → Workspace → Session` es **contención** (quién contiene a quién).
- **User y Team NO son nodos de ese árbol** — son **capas globales** que se
  superponen sobre *todos* los projects.

La config se resuelve como **`User ⊕ Team ⊕ Project ⊕ Workspace`** (cada nivel
aporta o pisa), pero solo Project/Workspace/Session viven en el árbol de contención.

| Capa | Qué | Dónde | Reproducible? |
|------|-----|-------|---------------|
| **Project** (versionado) | lenses, commands, convenciones del repo — compartido con el equipo | commiteado en el repo | ✅ viaja por git |
| **Team/Org** | los MCP del equipo, skills de la casa | fuente central compartida | ✅ |
| **User** (personal + secrets) | preferencias, **API keys** | `~/.omega/` | ❌ local a la máquina (a propósito) |

**La tensión de los secrets**: las keys de `mcp.json` no se pueden versionar, pero
la FORMA (qué servers, qué lenses) sí. El modelo team parte eso: **declaraciones
versionadas (project/team) + secrets inyectados desde el user scope**.

**El tell del gitignore**: hoy `.omega/` está en `.gitignore` → la config de
proyecto NO viaja con el repo → no es compartible ni reproducible ("lo que haya en
la laptop de cada dev"). Para producción eso es lo contrario de lo que querés. El
mundo team pide **des-gitignorear la parte compartible** (o un subset) y separar
los secrets.

## 3. Por qué es la fundación del distribuido

Un `WorkspaceContext` con config en capas explícitas es exactamente lo que hace que
un agente se comporte **idéntico en tu laptop, en medra-box o en un contenedor
cloud** — resuelve de fuentes ligadas al workspace, no de un `cwd` implícito de la
máquina. La resolución de config siendo un paso limpio y explícito es el enabler
del norte distribuido (ver `omega-distributed`), no un detalle.

## 4. Qué se construyó ya (WorkspaceContext)

`src/workspace-context.ts`: `WorkspaceContext(cwd)` resuelve `projectRoot`
(git-root, o cwd si no es repo) y expone `loadMcp()`/`loadSkills()`/`loadCommands()`
— cada uno del `.omega/` del proyecto con **fallback al global `~/.omega/`**.
`createAgentStack(cwd)` lo construye y todo (MCP, skills, system prompt) sale de
ahí, no de `process.cwd()`. Bonus sobre el fix crudo del #116: como resuelve del
`projectRoot`, el config se encuentra aunque la sesión opere en un subdir del repo.

## 5. Qué falta (roadmap)

1. **ProjectContext** — cachear la config compartida por-repo (hoy cada
   WorkspaceContext re-resuelve la suya; N worktrees del mismo repo re-leen lo mismo).
2. **Auditar los `process.cwd()` que quedan** — handlers de comandos (`/cabinet`,
   `/mcp`), el `dir ".omega/sessions"`/`".omega/logs"` de `buildCore`, los overrides
   del clasificador. Todos deben colgar del WorkspaceContext.
3. **Modelo de 3 capas para el equipo** — des-gitignorear el project scope
   compartible, definir el team scope, separar secrets. Es el paso Medra-producción.

## Conecta con

- `omega-distributed` — local == remoto == cloud vía contexto explícito.
- `omega-mission-control` — el daemon como host multi-proyecto.
- `omega-for-medra` — reproducibilidad + config de equipo para producción.
