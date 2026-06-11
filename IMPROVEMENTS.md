# Mejoras identificadas en el proyecto Omega

## 1. **Error Handling en AnthropicProvider**

- **Ubicación:** `src/providers/anthropic-llm-provider.ts`
- **Problema:** El manejo de errores es muy genérico. Cuando falla una llamada a la API, solo se loguea sin contexto suficiente
- **Mejora:**
  - Parsear errores de Anthropic específicamente
  - Diferencial entre 401 (invalid key), 429 (rate limit), 400 (bad request)
  - Hacer retry automático con backoff exponencial para 429 y 529

## 2. **Falta de timeout en las llamadas a la API**

- **Ubicación:** `src/providers/anthropic-llm-provider.ts`
- **Problema:** El `fetch` no tiene timeout configurado
- **Mejora:** Agregar un timeout de 30-60 segundos para evitar esperas infinitas

## 3. **Límite de pasos hardcodeado**

- **Ubicación:** `src/runner.ts` línea 27: `let steps = 15`
- **Problema:** El máximo de pasos es fijo y no es configurable
- **Mejora:** Hacer que `maxSteps` sea un parámetro pasable al Runner

## 4. **Session no tiene persistencia**

- **Ubicación:** `src/session.ts`
- **Problema:** La sesión solo existe en memoria y se pierde al terminar
- **Mejora:** Agregar opción de guardar/cargar sesiones a JSON o SQLite

## 5. **Falta validación de variables de entorno**

- **Ubicación:** `src/index.ts` y `src/providers/anthropic-llm-provider.ts`
- **Problema:** Si falta `ANTHROPIC_API_KEY` solo falla en runtime
- **Mejora:** Validar al iniciar que todas las variables necesarias existan

## 6. **No hay logging**

- **Ubicación:** Todo el proyecto
- **Problema:** Difícil debuguear qué está pasando en producción
- **Mejora:** Agregar un sistema de logging (winston o pino)

## 7. **WriteTool tiene validación frágil**

- **Ubicación:** `src/tools/write.ts`
- **Problema:** `!path.trim()` asume que path es string; fallará si input no se desestructura bien
- **Mejora:** Validar el tipo de input antes de desestructurar

## 8. **No hay tests**

- **Ubicación:** Proyecto completo
- **Problema:** Cambios pueden romper cosas sin saberlo
- **Mejora:** Agregar suite de tests con jest o vitest

## 9. **Documentación incompleta**

- **Ubicación:** README no existe, solo API.md
- **Problema:** No hay instrucciones de cómo usar el proyecto
- **Mejora:** Crear README.md con setup, usage, architecture

## 10. **Tool de bash sin límites de seguridad**

- **Ubicación:** `src/tools/bash.ts`
- **Problema:** Se pueden ejecutar comandos arbitrarios sin restricciones
- **Mejora:** Implementar lista de comandos permitidos/bloqueados
