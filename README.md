# Omega — Asistente de coding en la terminal

Omega es un asistente de IA que trabaja directamente sobre tu proyecto: lee, escribe y edita archivos, ejecuta comandos bash, y resuelve tareas de desarrollo en un loop agéntico. Corre en la terminal con una TUI completa (raw mode, editor multilínea, historial, spinner animado).

## Instalación

```bash
npm install
npm run build
```

## Configuración

Creá un archivo `.env` en la raíz del proyecto, o en `~/.omega/.env` para tenerlo disponible globalmente:

```bash
OPENROUTER_API_KEY=sk-or-...       # requerida
MODEL=claude-haiku-4-5-20251001    # modelo (formato OpenRouter: anthropic/claude-...)
MAX_TOKENS=1024
MAX_STEPS=15
MAX_CONTEXT_MESSAGES=50
MAX_CONTEXT_TOKENS=100000
```

## Uso

```bash
npm run dev
```

Escribí tus tareas en lenguaje natural. Omega va a explorar el proyecto, editar archivos y ejecutar comandos para resolverlas.

### Comandos slash

Al tipear `/` aparece un menú en vivo con todos los comandos disponibles
(built-in + custom), filtrado a medida que escribís. ↑/↓ (o Ctrl+P/N) para
navegar, **Enter** corre el resaltado, **Tab** lo completa en el editor para
pasarle argumentos, **Esc** cierra el menú.

| Comando | Acción |
|---------|--------|
| `/help` | Lista los comandos disponibles |
| `/clear` | Limpia la terminal |
| `/rename <nombre>` | Le da un nombre a la sesión actual |
| `/resume <id>` | Reanuda una sesión anterior |

### Comandos slash custom

Además de los built-in, podés definir tus propios comandos con archivos `.md`. El
nombre del archivo es el comando (`resumen.md` → `/resumen`) y el body es un
template de prompt que se manda al modelo como si lo hubieras tipeado.

- `.omega/commands/*.md` — del proyecto (versionable, compartido con el equipo).
- `~/.omega/commands/*.md` — globales (tuyos, en cualquier repo). El de proyecto
  gana si hay choque de nombre.

Frontmatter opcional (`description`, `argument-hint`) y sustitución de
argumentos: `$ARGUMENTS` (todos) y `$1`..`$9` (posicionales).

```md
---
description: Resume el git diff actual en bullets
argument-hint: [rama-base]
---
Mirá el diff contra $1 (o master si está vacío) y resumí los cambios en bullets
concisos, agrupados por archivo. No propongas cambios, solo describí.
```

Después: `/resumen develop`. Aparecen en `/help`.

### Skills

Una **skill** es una guía con instrucciones detalladas para una tarea o
capacidad específica que **el modelo carga solo cuando le hace falta** (a
diferencia de un slash command, que lo disparás vos). Es *progressive
disclosure*: al system prompt solo entra el `name` + la `description` de cada
skill; el contenido completo se carga on-demand cuando el agente decide usarla.

- `.omega/skills/<name>/SKILL.md` — del proyecto (versionable).
- `~/.omega/skills/<name>/SKILL.md` — globales. El de proyecto gana si hay choque.

El frontmatter lleva `name` (opcional, default = nombre del dir) y `description`
(clave: es lo que el modelo usa para decidir si la skill aplica). El directorio
puede traer archivos extra (scripts, plantillas) que las instrucciones
referencian — el agente los lee con `read`.

```md
---
name: release-notes
description: Cómo armar las release notes del proyecto siguiendo su formato
---
1. Mirá los commits desde el último tag con `git log`.
2. Agrupá por tipo (feat/fix/chore) y escribí una línea por cambio relevante.
3. Seguí la plantilla en `template.md` de esta misma carpeta.
```

Cuando una tarea matchee la descripción, el agente carga la skill (vía una tool
`skill` interna) y sigue sus instrucciones. Si no hay skills instaladas, nada de
esto aparece.

### Atajos del editor

| Atajo | Acción |
|-------|--------|
| Ctrl+A | Ir al inicio de línea |
| Ctrl+E | Ir al final de línea |
| Ctrl+U | Borrar desde inicio de línea hasta el cursor |
| Ctrl+K | Borrar desde el cursor hasta fin de línea |
| Ctrl+W | Borrar palabra hacia atrás |
| Up/Down | Navegar historial de comandos |

## Arquitectura

```
index.ts (entry point)
  ├── Config (validateEnv)
  ├── Session (historial de mensajes, persistencia)
  ├── AgentConfig (system prompt + tools registradas)
  ├── OpenRouterProvider (llamada al LLM vía OpenRouter)
  ├── Runner (loop agéntico)
  ├── Screen / LineEditor / Spinner / DisplayText (TUI)
  └── Comandos slash (/clear, /help, /rename, /resume)
```

## Tools disponibles

| Tool | Descripción |
|------|-------------|
| `read` | Lee archivos, con offset y limit opcionales |
| `write` | Crea o sobrescribe archivos |
| `edit` | Reemplaza texto exacto en un archivo (falla si hay 0 o >1 ocurrencias) |
| `bash` | Ejecuta comandos bash (con guardarraíles de seguridad) |

## Scripts

- `npm run build` — Compilar TypeScript
- `npm run dev` — Modo watch con `node --watch`
- `npm test` — Tests unitarios con Vitest
- `npm run test:ui` — UI para tests
- `npm run test:coverage` — Cobertura

## Sesiones

Las sesiones se persisten en `.omega/sessions/<uuid>.json`. Cada sesión guarda el historial completo de mensajes, costo acumulado y tokens consumidos. Usá `/resume <id>` para retomar una sesión anterior.

## Seguridad

- Timeout de 60s en llamadas a la API
- Retry automático con backoff exponencial para rate limits (429/529)
- Comandos bash bloqueados: `rm -rf /`, fork bombs, escritura a discos
- Acceso bloqueado a archivos `.env`, `.env.*`, `.envrc`
- Logging completo de todas las operaciones en `.omega/logs/`

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | — | API key de OpenRouter (requerida) |
| `MODEL` | `claude-haiku-4-5-20251001` | Modelo a usar |
| `MAX_TOKENS` | `1024` | Tokens máximos por respuesta |
| `MAX_STEPS` | `15` | Pasos máximos del loop agéntico |
| `MAX_CONTEXT_MESSAGES` | `50` | Máximo de mensajes en contexto |
| `MAX_CONTEXT_TOKENS` | `100000` | Máximo de tokens en contexto |
| `NODE_ENV` | `development` | Entorno |
