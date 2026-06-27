# Comando `/mcp` — Diseño

**Estado:** diseño cerrado, listo para implementar (ver `mcp-command-implementation.md`).

## 1. Motivación

Hoy, cuando un server MCP pierde la auth (ej: Linear con `mcp-remote`, el token
OAuth venció → `auth_revoked`), el agente dice "re-autenticate" pero el usuario no
tiene visibilidad ni forma de hacerlo desde adentro de omega — tiene que acordarse
del `rm -rf ~/.mcp-auth` y correr `mcp-remote` a mano.

El comando `/mcp` da las dos cosas que da Claude Code:
1. **Visibilidad** — en qué estado está cada server (configurado / conectado / error).
2. **Re-auth desde adentro** — `/mcp auth <server>` dispara el flujo OAuth sin salir.

## 2. El comando

**`/mcp`** (sin args) → tabla de estado de todos los servers configurados en
`.omega/mcp.json`:

```
linear   ⚠ auth requerida   npx mcp-remote https://mcp.linear.app/mcp
                             último error: auth_revoked (Session expired)
                             → /mcp auth linear
mock     ● conectado         node dist/mcp/mock-server.js
weather  ○ configurado       npx -y weather-mcp
```

Símbolos: `●` conectado · `⚠` error/auth requerida · `○` configurado (lazy, sin
conectar todavía).

**`/mcp auth <server>`** → re-autenticar:
1. Desconecta el client (mata el proceso si está vivo).
2. Limpia el cache de token de `mcp-remote` (`~/.mcp-auth`).
3. Reconecta → `mcp-remote` ve que no hay token → **abre el browser** → el usuario
   autoriza → guarda el token → completa el handshake.
4. omega muestra "Abrí el browser para autenticar `<server>`… esperando…" y al
   terminar "✓ `<server>` autenticado" o el error.

## 3. Modelo de estado

El `McpClient` trackea:
- `status: "idle" | "connected" | "error"`.
- `lastError?: string`.
- `needsAuth: boolean` (true si el último error fue de auth).

Se actualiza en:
- `configureMcp` → `idle` (no conectado).
- `connect()` ok → `connected`; falla → `error` + `lastError`.
- `callTool()` que devuelve error de **auth** (el texto matchea `auth_revoked`,
  `401`, `unauthorized`, `not authenticated`, `session expired`) → `error` +
  `lastError` + `needsAuth = true`. (Importante: un server puede estar "conectado"
  pero perder la auth en una call — el estado tiene que reflejarlo.)

## 4. El flujo de auth (por qué clear + reconnect)

El Linear MCP (`mcp.linear.app`) usa OAuth 2.1; `mcp-remote` es el puente que
guarda el token en `~/.mcp-auth`. Cuando el token se **revoca** del lado del
servidor, `mcp-remote` NO se recupera solo (bug conocido) — hay que limpiar el
cache para forzar un re-auth desde cero. Por eso `/mcp auth` hace clear +
reconnect, en vez de solo reconnect.

Al reconectar sin token, `mcp-remote` abre el browser y arranca su callback local;
el `connect()` de omega **espera** (await) hasta que el handshake completa, o sea
hasta que el usuario autoriza. La UI muestra el "esperando…" mientras tanto, con un
timeout (ej: 3 min) para no colgar si abandona el flujo.

## 5. Caveats (honestos)

- **omega NO implementa OAuth** — *maneja* `mcp-remote`. La parte de "limpiar
  `~/.mcp-auth`" es conocimiento de `mcp-remote` que se filtra. Aceptable para una
  tool personal.
- **`rm -rf ~/.mcp-auth` limpia los tokens de TODOS los servers OAuth**, no solo el
  target. Para la escala típica (uno o dos servers) está bien; el comando lo avisa.
- **El flujo de auth bloquea el prompt** mientras el usuario está en el browser
  (con timeout). Es esperado — no podés hacer otra cosa hasta autorizar.
- **Servers con API-key** (auth por env var en `mcp.json`) NO usan `/mcp auth` — no
  necesitan browser. `/mcp` igual les muestra el estado.

## 6. Qué se toca

- `McpClient`: campos `status`/`lastError`/`needsAuth` + getters; detección de auth
  errors en `callTool`; un método `reauthenticate()` (clear cache + reconnect).
- `ToolRegistry`: `getMcpStatus()` (lista el estado de cada client) y
  `reauthenticate(serverName)`.
- Comando nuevo `/mcp` en `src/commands/`, registrado en el `commandsMap`, con las
  sub-acciones `/mcp` (status) y `/mcp auth <server>`. Accede al registry vía `ctx`.

## 7. Qué NO hace v1

- `/mcp connect|disconnect <server>` explícitos — después, si hace falta (hoy la
  conexión es lazy por search).
- Implementar el flujo OAuth nativo (sin `mcp-remote`) — se delega.
