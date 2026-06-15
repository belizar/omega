edit

Editado src/index.ts correctamente.

Ahora cambio la línea de métricas para usar los datos de sesión en vez de la variable local, y llamar a `session.addUsage()`

edit

Editado src/index.ts correctamente.

⠹ PensandoSyntaxError: Unterminated string in JSON at position 149 (line 1 column 150)
at JSON.parse (<anonymous>)
at parseResponse (file:///Users/benjaminlizarraga/Workspace/omega/dist/providers/openrouter-llm-provider.js:110:29)
at OpenRouterProvider.callWithRetry (file:///Users/benjaminlizarraga/Workspace/omega/dist/providers/openrouter-llm-provider.js:161:24)
at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
at async Runner.run (file:///Users/benjaminlizarraga/Workspace/omega/dist/runner.js:24:26)
at async main (file:///Users/benjaminlizarraga/Workspace/omega/dist/index.js:101:20)
error Command failed with exit code 1.
info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.
