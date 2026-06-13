# Omega - AI Agent para Desarrollo

Un asistente de IA potente que ejecuta comandos, lee, escribe y edita archivos. Perfecto para automatizar tareas de desarrollo.

## Instalación

```bash
npm install
```

## Configuración

Crear archivo `.env`:
```
ANTHROPIC_API_KEY=your_key_here
MODEL=claude-haiku-4-5-20251001
MAX_TOKENS=1024
MAX_STEPS=15
NODE_ENV=development
```

## Uso

```bash
npm run dev
```

Luego interactúa escribiendo comandos en el REPL.

## Arquitectura

```
┌─────────────┐
│    REPL     │ (transport.ts) - Interfaz usuario
└──────┬──────┘
       │
┌──────▼──────────────────────┐
│    Session                   │ Maneja historial de mensajes
└──────┬──────────────────────┘
       │
┌──────▼──────────────────────┐
│    Runner                    │ Orquesta el loop agéntico
└──────┬──────────────────────┘
       │
    ┌──┴──────────────────────────┐
    │                             │
┌───▼────────────────────┐  ┌────▼──────────────┐
│ AnthropicProvider      │  │  AgentConfig     │
│ (Habla con Anthropic)  │  │ (Herramientas)   │
└────────────────────────┘  └───────┬──────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
             ┌──────▼─────┐  ┌──────▼─────┐  ┌────▼──────┐
             │ ReadTool   │  │ WriteTool  │  │ EditTool  │
             └────────────┘  └────────────┘  └───────────┘
             
                         ┌──────────────┐
                         │  BashTool    │
                         └──────────────┘
```

## Tools disponibles

- **read**: Lee archivos (con offset/limit)
- **write**: Crea o sobrescribe archivos
- **edit**: Reemplaza texto exacto en archivos
- **bash**: Ejecuta comandos (con validación de seguridad)

## Scripts

- `npm run build` - Compilar TypeScript
- `npm run dev` - Correr en modo watch
- `npm test` - Tests unitarios
- `npm run test:ui` - UI para tests
- `npm run test:coverage` - Cobertura

## Seguridad

- Timeout de 60s en llamadas a API
- Retry automático con backoff para errores 429/529
- Comandos bash bloqueados: `rm -rf /`, fork bombs, escritura en disco
- Validación de input en todas las herramientas
- Logging completo de todas las operaciones

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| ANTHROPIC_API_KEY | - | API key de Anthropic (requerido) |
| MODEL | claude-haiku-4-5-20251001 | Modelo a usar |
| MAX_TOKENS | 1024 | Tokens máximos por respuesta |
| MAX_STEPS | 15 | Pasos máximos del agente |
| NODE_ENV | development | environment |
