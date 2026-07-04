# Outline tool — Diseño

**Estado:** diseño cerrado, listo para implementar (ver `outline-tool-implementation.md`).

## 1. Motivación

Hoy omega lee archivos **enteros** con `read`. En un repo chico anda; en un
monorepo grande (Medra) eso revienta el contexto y es lento — el agente lee 400
líneas para tocar 5. La outline tool implementa el protocolo **"outline para
encontrar, read del rango para tocar"**: el agente ve la *estructura* de un
archivo barata (firmas, sin cuerpos), y solo lee el cuerpo del rango que necesita.

Es lo que hace omega usable en un codebase de verdad, no solo en su propio repo.

## 2. La tool: `outline(path)`

- `path` es un **archivo** → outline **profundo**: cada declaración (imports,
  clases con sus métodos, funciones, types, enums, consts top-level) con su
  **firma completa** y su **rango de líneas**, sin los cuerpos.
- `path` es un **directorio** → outline **shallow**: cada archivo + solo sus
  exports top-level (sin miembros ni rangos), y los nombres de los subdirs. Un
  mapa para saber a qué archivo entrar.

### Formato — archivo

```
src/runner.ts · 397 líneas
  imports: ./agent-config, ./context-management, ./logger, ./message, ./providers/llm-provider   [1-10]
  type RunnerEvent                                                         [23-35]
  class Runner                                                            [45-396]
    async #callLLM(prunedContext: Message[], state: TurnState): AsyncGenerator<RunnerEvent>   [135-196]
    async #executeTools(state: TurnState): AsyncGenerator<RunnerEvent>                        [204-240]
    async run(incomingContext: readonly Message[]): AsyncGenerator<RunnerEvent>               [292-376]
    getMetrics(): Metrics                                                                     [378-383]
```

- Firmas completas (params + return type, **como están escritas** — sintáctico,
  sin inferir).
- Miembros privados incluidos (con `#` o `private`).
- Rangos `[inicio-fin]` que **calzan directo con `read(path, offset, limit)`** —
  outline y read componen.

### Formato — directorio

```
src/tools/ · 7 archivos
  read.ts     export class ReadTool
  write.ts    export class WriteTool
  edit.ts     export class EditTool, type EditInput
  bash.ts     export class BashTool
  outline.ts  export class OutlineTool
  tool.ts     export abstract class Tool<Tin, Tout>
  (sin subdirs)
```

## 3. El empujón estructural (en `read`)

El modelo barato ignora instrucciones de prompt (ya lo vimos con el `##`, el
clasificador, edit-vs-write). Así que **no confiamos en "outline antes de read"**:
lo forzamos en la tool `read`.

- `read` de un archivo **TS/JS de más de N líneas** sin `offset/limit` → en vez
  del archivo entero, devuelve el **outline** + "este archivo tiene N líneas,
  pedí un rango con offset/limit, o `full: true` para todo".
- `read` **con** `offset/limit` → devuelve ese rango, sin empujón.
- `read` con `full: true` → escape hatch, lee todo igual.

`N` configurable por env (`OUTLINE_THRESHOLD`, default **200**). Archivos
chicos/medianos y no-código se leen enteros normal.

Resultado: el agente cae naturalmente en "outline → read del rango" sin depender
de que obedezca el prompt.

## 4. Cómo encaja en el monorepo (Medra)

No se outlinea todo de entrada. El flujo es: `grep`/glob para encontrar
candidatos → `outline` para entender la estructura → `read` del rango justo. El
outline da el **qué**; el **por qué** de cada package (lo no-derivable) vive
curado a mano en `AGENT.md`.

## 5. Decisiones tomadas

1. **Firmas completas** (params + return), no solo nombres — es lo que le dice al
   agente qué hace algo sin leer el cuerpo.
2. **Empujón estructural** en `read`, no solo prompt.
3. **TS-only** vía el TS compiler — cero deps nuevas (`typescript` ya está),
   evita tree-sitter y sus bindings nativos (que ya rompieron con vitest).
4. **Sintáctico y stateless**: `ts.createSourceFile` (sin Program ni tsserver),
   fresco por llamada, cero RAM. No compite con el tsserver de tu nvim, no hay 2
   servidores por worktree.
5. Imports se muestran como **módulos importados** (de qué depende el archivo).
6. Dir-outline es **un solo nivel** (lista subdirs por nombre para drill).
7. Escape hatch del `read` = `full: true`.

## 6. Qué NO hace v1

- Multi-lenguaje (tree-sitter) — después, si hace falta.
- Índice pre-construido del monorepo entero — es on-demand por archivo/dir.
- Server caliente / cache — stateless a propósito (el agente no necesita latencia
  de IDE).
