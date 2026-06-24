# AGENT.md — Omega

## Qué es Omega

Un asistente de coding que corre en la terminal. El usuario le pide tareas en lenguaje natural y omega ejecuta tools (bash, read, write, edit) sobre el proyecto en un loop agéntico hasta resolver la tarea.

El agente que describe este documento es el mismo omega: todo lo que corre en `npm run dev` está documentado acá.

## Cómo correrlo

```bash
npm install
npm run build        # compilar TypeScript
npm run dev          # modo watch con node --watch
npm test             # tests con Vitest
```

El entry point es `src/index.ts`.

## Variables de entorno (.env)

```
ANTHROPIC_API_KEY=sk-ant-...       # requerida
OPENROUTER_API_KEY=sk-or-...       # opcional, usa OpenRouter si está presente
MODEL=claude-haiku-4-5-20251001    # modelo (formato openrouter: anthropic/claude-...)
MAX_TOKENS=4096
MAX_STEPS=15
MAX_CONTEXT_MESSAGES=50
MAX_CONTEXT_TOKENS=100000
```

## Arquitectura

```
index.ts (entry point)
  ├── Config (validateEnv)
  ├── Session (historial de mensajes, persistencia)
  ├── AgentConfig (system prompt + tools registradas)
  ├── OpenRouterProvider / AnthropicProvider (llamada al LLM)
  ├── Runner (loop agéntico)
  ├── TUI (LineEditor, Spinner, DisplayText, render loop)
  └── Comandos slash (/clear, /help, /rename, /resume)
```

## Flujo de una interacción

1. Usuario tipea en el `LineEditor` (raw mode, multilínea, historial).
2. Si es un comando `/`, se despacha y vuelve al prompt.
3. Si es texto, se agrega como mensaje `user` a la sesión.
4. `Runner.run()` llama al LLM provider con los mensajes (poda de contexto primero).
5. El LLM responde con bloques `text` y/o `tool_use`.
6. Si hay `tool_use`, el runner ejecuta la tool, captura el output, lo trunca si es largo, y lo manda como `tool_result`. El loop sigue hasta `end_turn`, `max_tokens` o `maxSteps`.
7. Muestra métricas: tokens, tools usadas, duración, costo en USD.

## Estructura de archivos

```
src/
  index.ts                  Entry point, inicializa todo y corre el REPL
  config.ts                 validateEnv()
  agent-config.ts           AgentConfig: system prompt, tools, modelo, maxTokens
  app-context.ts            Context: session + agentConfig + runner (para comandos)
  message.ts                Tipos Message, ToolMessage, TextMessage
  session.ts                Session: historial, persistencia, poda, costos
  context-management.ts     pruneContext (turn-aware), truncate, estimateTokens
  runner.ts                 Runner: loop agéntico, emite eventos, ejecuta tools
  logger.ts                 Logger a archivo en .omega/logs/
  providers/
    llm-provider.ts         Clase abstracta, tipos Block/LLMResponse, pricing
    openrouter-llm-provider.ts  Provider principal: traduce mensajes a formato OpenAI
    anthropic-llm-provider.ts   Provider alternativo directo a Anthropic
  tools/
    tool.ts                 Clase abstracta Tool<Tin, Tout>
    bash.ts                 BashTool: ejecuta comandos con guardarraíles
    read.ts                 ReadTool: lee archivos con offset/limit
    edit.ts                 EditTool: reemplazo quirúrgico (match exacto)
    write.ts                WriteTool: crea/sobrescribe archivos
    env-guard.ts            Bloquea acceso a archivos .env
  tui/
    component.ts            Interfaz InputComponent<T>
    decodeKey.ts            Decodifica secuencias de escape ANSI
    terminal.ts             enableRawMode / disableRawMode
    render.ts               Loop de renderizado
    theme.ts                Colores (dim, bold, etc.)
    components/
      line-editor.ts        Editor de línea multilínea con historial
      spinner.ts            Spinner animado durante llamadas al LLM
      display-text.ts       Muestra texto del assistant, tool calls y resultados
  commands/
    command.ts              Interfaz Command<T>
    index.ts                dispatchCommand: rutea comandos slash
    clear.ts                /clear — limpia la terminal
    help.ts                 /help — lista comandos
    rename.ts               /rename <nombre> — renombra la sesión
    resume.ts               /resume <id> — reanuda una sesión guardada
  __tests__/                Tests unitarios con Vitest
docs/
  improvements.md           Ideas de mejoras
  line-editor-design.md     Diseño del editor de línea
  memory-system-design.md   Diseño del sistema de memoria/contexto
```

## Tools disponibles

Cada tool hereda de `Tool<Tin, Tout>` y define `name`, `description`, `input_schema` (JSON Schema) y `execute()`.

| Tool | Descripción |
|---|---|
| `read` | Lee archivos, con offset y limit opcionales |
| `write` | Crea o sobrescribe archivos |
| `edit` | Reemplaza texto exacto en un archivo (falla si hay 0 o >1 ocurrencias) |
| `bash` | Ejecuta comandos bash |

Las tools bloquean acceso a archivos `.env`, `.env.*`, `.envrc` (ver `env-guard.ts`). BashTool además bloquea `rm -rf`, fork bombs, escritura a discos, etc.

## Proveedores LLM

### OpenRouter (principal)
- `OpenRouterProvider` extiende `LLMProvider`.
- Traduce los `Message[]` de omega a formato OpenAI (`tool_calls`, `tool` role, etc.).
- Endpoint: `https://openrouter.ai/api/v1/chat/completions`.
- Pricing: tabla en `llm-provider.ts` con precios por millón de tokens.
- Timeout 60s, retry con backoff para 429/529.

### Anthropic (alternativo)
- `AnthropicProvider` habla directo con la Messages API de Anthropic.
- Endpoint: `https://api.anthropic.com/v1/messages`.

## Sistema de contexto

- `pruneContext` poda mensajes viejos para no pasarse de `MAX_CONTEXT_TOKENS`.
- Es **turn-aware**: nunca corta en medio de un par `tool_use`/`tool_result`, ni deja un `assistant` como primer mensaje de la ventana.
- Estimación de tokens: ~3 chars/token (tiende a sobrestimar, seguro).
- `truncate` capa outputs largos a 200 líneas / 8000 chars.

## Sesiones

- Se persisten en `.omega/sessions/<uuid>.json`.
- Guardan: mensajes completos, `totalCost`, `totalTokens`, `name`.
- Comandos: `/rename` para nombrar, `/resume <id>` para reanudar.

## TUI

- Raw mode (`enableRawMode` de `terminal.ts`).
- `LineEditor`: multilínea, historial con flechas, atajos emacs-like (Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+K, Ctrl+W).
- `Spinner`: animación mientras el LLM procesa.
- `DisplayText`: muestra respuestas del assistant, tool calls y resultados con colores.

## Convenciones de código

- TypeScript estricto (`strict: true`).
- ESM (type: module, NodeNext).
- Campos privados con `#` (hard privacy).
- Todas las tools devuelven `string` (nunca throw; errores se capturan y devuelven como string).
- Logger a archivo (`.omega/logs/`) con niveles info, warn, error, debug.
