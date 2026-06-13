Implementá un nuevo provider de LLM para OpenRouter, en un archivo nuevo
src/providers/openrouter-llm-provider.ts. NO toques el Runner, el tipo Message,
ni las tools. El provider tiene que conformar a la interfaz LLMProvider existente
(misma firma `call(messages, agent)`) y devolver EXACTAMENTE la misma forma de
respuesta que hoy devuelve AnthropicProvider y que el Runner ya consume:
{ content: Block[], stop_reason: "end_turn" | "tool_use", usage: { input_tokens, output_tokens } }
donde Block es { type:"text", text } o { type:"tool_use", id, name, input }.

Leé primero src/providers/anthropic-llm-provider.ts, src/providers/llm-provider.ts,
src/agent-config.ts, src/message.ts y src/runner.ts para entender los tipos y la
forma exacta que el Runner espera. Imitá esa forma.

OpenRouter habla formato OpenAI Chat Completions. Detalles del protocolo:

ENDPOINT Y AUTH:

- POST https://openrouter.ai/api/v1/chat/completions
- Header: "Authorization": "Bearer <API_KEY>" (NO x-api-key)
- "Content-Type": "application/json"
- La API key se lee de process.env.OPENROUTER_API_KEY (pasala por constructor como
  hace AnthropicProvider con su key; agregá la env var a config.ts si corresponde).

ENTRADA — traducí el historial (Message[] formato Anthropic) a mensajes OpenAI:

- El system prompt (agent.systemPrompt) va como un mensaje { role:"system", content }
  al principio del array.
- Un Message user con content string → { role:"user", content }.
- Un Message assistant cuyo content es un array de bloques Anthropic → un mensaje
  { role:"assistant", content, tool_calls } donde:
  - los bloques type:"text" se concatenan en `content` (o null si no hay texto)
  - cada bloque type:"tool_use" {id,name,input} → un elemento de tool_calls:
    { id, type:"function", function:{ name, arguments: JSON.stringify(input) } }
- Un Message user cuyo content es un array de tool_result → por CADA tool_result
  un mensaje aparte { role:"tool", tool_call_id: <tool_use_id>, content: <content as string> }.

TOOLS — traducí agent.tools() (cada una con toJSON() = {name, description, input_schema}) a:
{ type:"function", function:{ name, description, parameters: <input_schema> } }
Mandá el array en el campo `tools` del body.

BODY: { model: agent.model, messages, tools, max_tokens: agent.maxTokens }

SALIDA — parseá la respuesta y devolvé la forma Anthropic que el Runner espera:

- const msg = data.choices[0].message
- content blocks: si msg.content es string no vacío → push { type:"text", text: msg.content }.
  Por cada msg.tool_calls[] → push { type:"tool_use", id: tc.id, name: tc.function.name,
  input: JSON.parse(tc.function.arguments) }. (OJO: arguments es un STRING JSON, hay que parsearlo.)
- stop_reason: si data.choices[0].finish_reason === "tool_calls" → "tool_use", si no → "end_turn".
- usage: { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens }
- Devolvé { content, stop_reason, usage }.

ERRORES: si !response.ok, logueá el body del error y tirá Error. Replicá el manejo
de timeout/retries de AnthropicProvider si te resulta simple, pero no es obligatorio.

Después de implementarlo:

1. Corré `npx tsc --noEmit` y arreglá cualquier error de tipos.
2. Mostrame el diff de lo que creaste/cambiaste antes de que yo lo pruebe.
   NO lo cablees todavía en index.ts (eso lo hago yo para probar con cuidado). Solo
   creá el archivo del provider y, si hizo falta, la env var en config.ts.
