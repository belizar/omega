# Anthropic Messages API — Referencia rápida

`POST https://api.anthropic.com/v1/messages`

## Headers

```
x-api-key: <ANTHROPIC_API_KEY>
anthropic-version: 2023-06-01
content-type: application/json
```

> `anthropic-version` es obligatorio y fijo (no es la versión del modelo).

## Request body

### Obligatorios

| Campo        | Tipo              | Notas                                  |
| ------------ | ----------------- | -------------------------------------- |
| `model`      | string            | Ej: `claude-haiku-4-5-20251001`        |
| `messages`   | `Message[]`       | El historial de la conversación        |
| `max_tokens` | integer           | Tope de tokens de **salida**           |

### Opcionales (los útiles)

| Campo            | Tipo                        | Notas                                                              |
| ---------------- | --------------------------- | ----------------------------------------------------------------- |
| `system`         | string \| `TextBlock[]`     | System prompt. **Top-level**, no dentro de `messages`             |
| `tools`          | `Tool[]`                    | Definiciones de tools disponibles                                 |
| `tool_choice`    | object                      | `{type:"auto"}` (def) \| `{type:"any"}` \| `{type:"tool",name}`   |
| `temperature`    | number 0–1                  | Default 1                                                          |
| `stop_sequences` | string[]                    | Corta la generación si aparece alguno                             |
| `stream`         | boolean                     | `true` → respuesta como SSE                                       |
| `top_p`/`top_k`  | number                      | Sampling, rara vez se tocan                                       |
| `metadata`       | `{ user_id: string }`       | Para tracking                                                     |
| `thinking`       | `{type:"enabled",budget_tokens}` | Extended thinking                                            |

## Message

```ts
{
  role: "user" | "assistant",
  content: string | Block[]   // string = atajo de un solo bloque de texto
}
```

El assistant SIEMPRE devuelve `content` como array de bloques.

## Bloques

### De entrada (los que mandás vos)

```ts
// Texto
{ type: "text", text: string }

// Resultado de una tool (va en un mensaje role:"user")
{ type: "tool_result", tool_use_id: string, content: string | Block[], is_error?: boolean }

// Imagen (para después)
{ type: "image", source: { type: "base64", media_type, data } }
```

### De salida (los que devuelve el modelo)

```ts
// Texto
{ type: "text", text: string }

// El modelo quiere usar una tool
{ type: "tool_use", id: string, name: string, input: object }
```

`input` viene ya parseado como objeto según el `input_schema` de la tool.

## Tool

```ts
{
  name: string,
  description: string,          // el modelo lo lee para decidir cuándo usarla — escribilo bien
  input_schema: {
    type: "object",
    properties: { /* ... */ },
    required: [ /* ... */ ]
  }
}
```

`input_schema` es JSON Schema crudo.

## Response body

```ts
{
  id: string,
  type: "message",
  role: "assistant",
  content: Block[],                 // text y/o tool_use
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence",
  stop_sequence: string | null,
  usage: {
    input_tokens: number,
    output_tokens: number,
    cache_read_input_tokens?: number,
    cache_creation_input_tokens?: number
  }
}
```

- `stop_reason: "tool_use"` → el modelo quiere que ejecutes algo. Buscás los bloques `tool_use`, ejecutás, devolvés `tool_result`, seguís el loop.
- `stop_reason: "end_turn"` → terminó de hablar. Cortás el loop.

## El ciclo agéntico (resumen)

```
1. messages = [{ role:"user", content:"<tarea>" }]
2. POST con messages + tools
3. push de la respuesta del assistant (content completo) a messages
4. stop_reason?
   - "end_turn"  -> break
   - "tool_use"  -> por cada bloque tool_use: ejecutar -> armar tool_result
                    -> push { role:"user", content:[tool_result...] }
                    -> volver a 2
```

## Errores HTTP comunes

| Status | Significado     | Qué hacer                                    |
| ------ | --------------- | -------------------------------------------- |
| 400    | request inválido | Leer el body del error, casi siempre lo dice |
| 401    | key inválida    | Revisar `x-api-key`                          |
| 429    | rate limit      | Backoff, mirar header `retry-after`          |
| 529    | overloaded      | Reintentar con backoff                       |
