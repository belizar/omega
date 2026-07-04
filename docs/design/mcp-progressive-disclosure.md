# MCP + Progressive Disclosure — Diseño

**Estado:** Fase 1 y 2 implementadas. Fase 3 pendiente (optimizaciones).

## 1. Motivación

Omega viene con 7 tools esenciales (read, write, edit, bash, grep, outline,
ask_user). Para un asistente de coding es suficiente, pero los usuarios
necesitan integrar servicios externos: GitHub, bases de datos, Slack, Jira, etc.

El problema de poner todas las tools en el system prompt es el costo en tokens:
cada tool con su schema ocupa ~200-400 tokens. Con 10 servidores MCP de 20
tools cada uno, serían 40k-80k tokens solo en definiciones, antes de empezar
a trabajar.

**Progressive disclosure** resuelve esto: el agente no recibe todas las tools,
recibe una meta-tool `tool_search` para descubrirlas bajo demanda. Las tools
MCP solo se cargan cuando el usuario pide algo que las tools esenciales no
cubren.

## 2. Arquitectura

```
Usuario: "chequeá los issues de GitHub"
  │
  ▼
Agente (LLM)
  │  No tiene tool github_* → llama tool_search("github issues")
  │
  ▼
ToolSearchTool.execute({ query: "github issues" })
  │
  ▼
ToolRegistry.search("github issues")
  ├── Busca en tools locales/cacheadas (no matchea)
  └── Itera servidores MCP configurados
        │
        ▼
      McpClient("github")
        ├── connect()           ← lazy: solo ahora lanza el proceso
        ├── listTools()         ← JSON-RPC tools/list
        └── Filtra las que matchean "github issues"
              │
              ▼
            McpToolWrapper      ← convierte McpToolDescriptor en Tool de Omega
              │
              ▼
            ToolRegistry.register(wrapper)  ← cachea para el resto de la sesión
  │
  ▼
Resultado: lista de tools matcheantes → el agente las llama directamente
```

## 3. Componentes

### 3.1 `ToolRegistry` (`src/tools/tool-registry.ts`)

Registro central de tools. Tres fuentes:

| Fuente | Visibilidad | Ciclo de vida |
|---|---|---|
| `local` | Siempre en cada request | Registradas en `index.ts` al iniciar |
| `cached` | En cada request tras descubrirse | Registradas por `tool_search` durante la sesión |
| `mcp` | Solo bajo demanda vía `tool_search` | Conexión lazy, schemas cacheados al descubrirse |

Métodos clave:

- `registerLocal(tool)` — tools esenciales (read, bash, etc.)
- `register(tool)` — tools dinámicas (descubiertas vía MCP)
- `getActiveTools()` — tools que van en cada request al LLM
- `search(query)` — busca en local + MCP; conecta servidores lazy
- `configureMcp(servers)` — carga config de `.omega/mcp.json`

### 3.2 `ToolSearchTool` (`src/tools/tool-search.ts`)

Meta-tool que el agente usa para descubrir tools. Siempre está disponible
(registrada como local). Su schema es mínimo (~300 tokens) y no crece con
la cantidad de servidores MCP.

El system prompt instruye al agente:

```
Tools esenciales (siempre disponibles):
- read, write, edit, bash, grep, outline, ask_user
- tool_search: buscá tools adicionales cuando necesites algo que las tools
  esenciales no cubren (ej: APIs, bases de datos, servicios externos).
  Después de encontrar una tool, usala directamente: ya queda registrada.
```

### 3.3 `McpClient` (`src/mcp/mcp-client.ts`)

Cliente JSON-RPC 2.0 sobre stdio. Implementa el protocolo MCP 2024-11-05.

Ciclo de vida:

1. Se crea con la config del servidor (sin lanzar proceso).
2. `connect()` lanza el proceso hijo, hace handshake `initialize` +
   `notifications/initialized`.
3. `listTools()` → `tools/list`.
4. `callTool(name, input)` → `tools/call`.
5. `disconnect()` mata el proceso.

Si el proceso muere, se marca como desconectado y reconecta automáticamente
en el próximo `connect()`.

### 3.4 `McpToolWrapper` (`src/mcp/mcp-tool-wrapper.ts`)

Adapta un `McpToolDescriptor` (schema JSON) a la interfaz `Tool` de Omega.
La ejecución se delega a `McpClient.callTool()`.

### 3.5 `mcp.json` (`.omega/mcp.json`)

Archivo de configuración de servidores MCP. Formato:

```json
{
  "servers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-postgres"],
      "env": { "DATABASE_URL": "${DATABASE_URL}" }
    }
  }
}
```

- `command`: ejecutable (node, npx, python, etc.)
- `args`: argumentos del comando
- `env`: variables de entorno. Soporta `${VAR}` para expandir variables del
  entorno del proceso padre.

Si el archivo no existe, `tool_search` solo busca entre tools locales. Cero
overhead.

## 4. Flujo de uso

### Sin MCP configurado

```
Usuario: "leé el archivo X"
Agente: llama read("X") directamente — tool_search no se invoca.
```

### Con MCP configurado

```
Usuario: "¿cuántos issues abiertos hay en el repo?"
Agente: no tiene tool para GitHub
  → llama tool_search({ query: "github issues" })
  → ToolRegistry.search("github issues"):
       conecta al server "github" (primera vez → lento, ~1-2s)
       lista tools, filtra por "github issues"
       cachea github_list_issues, github_get_issue, etc.
  → devuelve lista: github_list_issues, github_get_issue, ...
Agente: elige github_list_issues → la llama directamente
  → McpToolWrapper.execute() → McpClient.callTool("github_list_issues", ...)
  → resultado: lista de issues

Próximo request en la misma sesión:
Agente: ya tiene github_* en cache → las llama sin tool_search.
```

## 5. Consumo de tokens

| Escenario | Tokens en tools |
|---|---|
| Sin MCP (7 tools locales + tool_search) | ~1,500 |
| MCP configurado, sin usar | ~1,500 (igual) |
| MCP usado: 1 server, 5 tools matchean | ~1,500 + ~1,250 (5 × ~250) = ~2,750 |
| MCP ingenuo (todas las tools en system prompt): 3 servers × 20 tools | ~15,000 |

El costo es **proporcional al uso real**, no al ecosistema disponible.

## 6. Fases de implementación

### Fase 1 ✅ — ToolRegistry + tool_search
- `ToolRegistry` unifica tools locales.
- `tool_search` busca entre tools locales.
- `AgentConfig` delega a `ToolRegistry`.
- Sin MCP todavía. Arquitectura lista, cero riesgo.

### Fase 2 ✅ — MCP Client + integración
- `McpClient` con JSON-RPC sobre stdio.
- `mcp.json` y carga de servers.
- `tool_search` busca también en MCP (conexión lazy).
- `McpToolWrapper` para adaptar tools MCP.
- Registro dinámico de tools MCP en la sesión.

### Fase 3 🔜 — Optimizaciones
- [ ] Cache de tool schemas entre sesiones (persistir en `.omega/mcp-cache.json`).
- [ ] Health checks y reconexión automática de servers MCP.
- [ ] Soporte HTTP/SSE además de stdio.
- [ ] Timeout configurable por server.
- [ ] `tool_forget` para liberar tools cacheadas y liberar tokens.
- [ ] Métricas: tokens ahorrados vs enfoque ingenuo.

## 7. Decisiones de diseño

### ¿Por qué stdio y no HTTP?

MCP define dos transports: stdio y HTTP/SSE. Elegimos stdio primero porque:

- Es el transport por defecto de la mayoría de servers MCP.
- No requiere puertos ni network.
- El proceso hijo se maneja con `child_process.spawn`, simple y portable.
- HTTP/SSE se puede agregar después como alternativa.

### ¿Por qué lazy connection?

Conectar todos los servers al iniciar Omega sería un desperdicio: la mayoría
de las sesiones no usan MCP. Conexión lazy significa que el proceso del server
solo se lanza cuando `tool_search` lo necesita.

### ¿Por qué cachear en la sesión y no entre sesiones?

Cachear entre sesiones (Fase 3) requiere invalidación: si el server MCP cambia
sus tools (nueva versión), el cache estaría stale. La estrategia actual
(recachear cada sesión en el primer `tool_search`) es conservadora y correcta.

### ¿Por qué no un comando `/mcp`?

Se consideró un comando `/mcp connect github` para que el usuario registre
servers manualmente. Se descartó porque:

- `mcp.json` es más simple y declarativo.
- El descubrimiento vía `tool_search` es más natural para el agente.
- Un comando `/mcp` podría agregarse después como sugar syntax.