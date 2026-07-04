# 0003 — Abstracción `LLMProvider` + OpenRouter como primario

- **Status:** accepted
- **Date:** 2026-07-04 _(backfill)_
- **Deciders:** Benjamin (+ Claude)

## Contexto

El loop no debería atarse a un proveedor de LLM. Se quiere poder probar modelos
distintos (Claude, DeepSeek, GPT, etc.) sin reescribir el runner, y comparar
costo/calidad entre ellos.

## Decisión

Una clase abstracta **`LLMProvider`** define el contrato (`call` / `callStream`,
tipos `Block`/`LLMResponse`, pricing). **OpenRouter es el provider primario**
(`OpenRouterProvider`), que traduce los `Message[]` de Omega al formato OpenAI y
da acceso a decenas de modelos por un solo endpoint. Hay un provider alternativo
directo a Anthropic. El modelo se resuelve por perfil + overrides de sesión.

## Consecuencias

- **Habilita** cambiar de modelo con `/model` y, a futuro, un harness de
  benchmarking (`docs/design/benchmarking-design.md`).
- **Costo:** traducir Omega↔OpenAI en cada turno (`translateMessages`), y una
  dependencia de OpenRouter para uptime y para el costo real (`usage.cost`).
- El streaming quedó no trivial: manejar `[DONE]`, tool_calls incrementales y
  abort mid-stream vive en `OpenRouterProvider.callStream`.
