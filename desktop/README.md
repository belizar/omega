# Omega Desktop (Tauri)

Cáscara nativa de Omega. Es **una ventana más del runtime**: no rebundlea la UI,
la webview apunta al daemon (`omega serve` en `http://localhost:4477`) y lo
renderiza como app nativa (dock, ventana propia, y —más adelante— notificaciones
nativas del SO + terminal).

El **core de omega sigue zero-dep**: todo el toolchain de Tauri (Rust + CLI) vive
acá, aislado en `desktop/`.

## Correrlo (dev)

Necesitás el daemon corriendo primero (la webview lo carga):

```bash
# 1. en una terminal: levantá el daemon
omega serve                 # o: node dist/index.js serve

# 2. en otra: la app nativa (compila Rust la primera vez, ~minutos)
cd desktop
npm install
npm run tauri dev
```

Se abre la ventana **Ω Omega** con el mission-control adentro.

## Estado (v1)

- La webview apunta a `http://localhost:4477` (`app.windows[0].url` en
  `src-tauri/tauri.conf.json`).
- **Todavía NO auto-spawnea el daemon** — asumí `omega serve` corriendo. El
  auto-spawn (Tauri arranca el daemon como sidecar al abrir) es el próximo paso.

## Estructura

- `src-tauri/` — el proyecto Tauri (Rust): `tauri.conf.json`, `Cargo.toml`,
  `src/main.rs` + `lib.rs`, `capabilities/`, `icons/`.
- `src/` — frontendDist mínimo (fallback). La UI real la sirve el daemon.

## Roadmap

1. ✅ Ventana nativa que envuelve el daemon (v1).
2. Auto-spawn del daemon como sidecar (Tauri lo arranca/espera al abrir).
3. Notificaciones nativas del SO (adiós al permiso del browser).
4. Terminal (xterm.js + PTY en el daemon — ver `docs/design/omega-terminal.md`).
5. Bundle/firma para distribución.
