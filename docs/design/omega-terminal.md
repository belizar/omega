# Diseño: terminal en el workspace

> Una tab de terminal interactiva por sesión — para abrir neovim, correr deploys,
> ver logs — que corre EN el workspace del daemon (local o remoto) y se pinta en
> el frontend. Otra proyección del mismo modelo, y el mejor payoff de lo remoto.

## 0. Por qué / cómo encaja

El daemon ya es dueño del workspace (el worktree, corra donde corra). Hoy el
agente corre `bash` ahí (no-interactivo, comando-por-comando). Un **terminal** es
lo mismo pero **interactivo y manejado por vos**: un PTY abierto en ese `cwd`,
streameado al frontend. Es una **tab más** al lado de Activity/Diff (ver
`omega-distributed` y el cockpit).

**Es el mejor argumento para lo remoto, no un conflicto:** cuando el daemon corra
en medra-box o un box en la nube, la tab Terminal te da una shell interactiva **en
esa máquina**, dentro del worktree, streameada a tu app local — "neovim + deploys
en el remoto" sin abrir un SSH aparte. El omega ya es el túnel. (Conductor tiene
"un terminal dedicado por workspace" — está en la referencia [[omega-conductor-reference]].)

**Regla arquitectónica: el PTY lo spawnea el DAEMON, no el frontend.** Es tentador
que Tauri (Rust) abra la terminal local — pero eso solo anda con daemon local y
rompe el modelo remoto. Si el daemon es dueño del PTY (en el workspace), anda
uniforme local y remoto. El frontend (web o Tauri) solo lo **renderiza**.

## 1. La frontera del zero-dep (decisión consciente)

Un terminal interactivo de verdad (neovim necesita raw mode, cursor addressing,
resize) **NO se puede con pipes** de `child_process` — necesita syscalls de PTY
que Node no expone. Suma tres piezas, y es la primera feature que cruza el
"zero-dep salvo dotenv+typescript":

| Pieza | Dónde | Qué es | Costo |
|-------|-------|--------|-------|
| **`node-pty`** | daemon | PTY nativo (el que usan VSCode/Hyper) | dep NATIVA — el costo real, aislable |
| **`xterm.js`** | frontend | emulador de terminal en el browser | dep JS — encaja con el patrón CDN (mermaid/hljs) o bundle en Tauri |
| **WebSocket** | transporte | canal bidireccional de baja latencia | hoy todo es SSE+POST; WS a mano sobre `http` (~120 líneas) o dep `ws` |

Es una frontera real, como Tauri es la de "todo-en-Node". Se cruza a propósito.

## 2. Arquitectura

### Backend — `TerminalSession` (una por PTY)

- Spawnea un shell con `node-pty` en el `cwd` del workspace: `pty.spawn(shell,
  [], { cwd, env, cols, rows })`.
- **Corre donde corre el bash del agente:** si la sesión tiene sandbox Docker
  (ver `src/sandbox.ts`), el terminal entra al contenedor (`docker exec -it`); si
  no, es el shell del host en el worktree. Así tu terminal = el mismo entorno que
  el agente.
- Bidireccional: `pty.onData` → WS → cliente; teclas del cliente → WS → `pty.write`.
  Evento `resize` → `pty.resize(cols, rows)`.
- **Ciclo de vida — persistente por sesión** (como tmux): el PTY sigue vivo aunque
  cierres el browser; reconectás y ves tu neovim donde lo dejaste. Cap de
  keep-alive + idle-timeout + se mata en `detach`/shutdown de la sesión (mismo
  patrón anti-huérfanos que el `Sandbox`). Reconexión: replay del último buffer
  (scrollback acotado) al conectar, como el `history` del chat.

### Transporte — WebSocket

- Ruta `GET /terminal?session=<id>` con upgrade a WS (el server `http` de Node
  maneja el evento `upgrade`). SSE+POST no sirve: cada tecla por POST metería
  latencia. WS es bidireccional y de baja latencia.
- Mensajes: `{t:'data', d:'…'}` (I/O), `{t:'resize', cols, rows}`. Texto/base64.
- **Decisión abierta:** framing WS a mano (zero-dep, fiddly pero acotado) vs. dep
  `ws`. Recomendación: empezar con `ws` si ya cruzamos la frontera con `node-pty`
  (coherencia: si aceptamos una dep nativa, una dep JS estándar de transporte no
  mueve la aguja); revisable.

### Frontend — tab Terminal

- xterm.js en una tab nueva (misma shell de tabs que Activity/Diff). `fit` addon
  para ajustar cols/rows al tamaño; `term.onData` → WS; `ws.onmessage` →
  `term.write`. Reconecta si el WS se cae.
- N terminales por workspace: v1 **una**; después, tabs/splits de terminal.

## 3. Seguridad — distinta del bash del agente

Punto importante: **el terminal es TU shell, no la del agente.**
- El **bash del agente** pasa por el clasificador de seguridad (dos capas, `adr/0006`)
  porque lo maneja el modelo. El **terminal lo manejás vos** (humano) → **NO se
  gatea**: sos vos tipeando, como cualquier terminal.
- Pero sigue siendo **ejecución de código interactiva expuesta por la red** → hereda
  el modelo de seguridad del daemon (`omega-distributed` §5): loopback por default,
  y para remoto **auth obligatoria** (token/túnel SSH). Un `/terminal` sin auth en
  `0.0.0.0` = shell root abierta. El WS debe exigir el mismo bearer token que el resto.

## 4. Cómo compone con el resto

- **Remoto:** el PTY vive en el daemon → shell en el box remoto, sobre el túnel SSH
  o TLS. Es *la* razón para querer lo remoto.
- **Tauri:** renderiza xterm.js en el webview (bundleado, sin CDN); el PTY sigue en
  el daemon. Tauri no cambia el modelo, mejora el render + el "feel de app".
- **Workspace compartido con el agente:** tu terminal y el agente comparten el
  worktree. Podés `nvim` para ver qué tocó, correr el deploy, los tests. (Ojo:
  edición concurrente vos+agente puede pisar — es tu workspace, tu responsabilidad.)
- **Sandbox:** si la sesión es sandboxeada, el terminal entra al contenedor →
  aislamiento consistente con el agente.

## 5. Roadmap

1. **`TerminalSession` + `node-pty` + ruta WS `/terminal`** (host cwd). El ladrillo.
2. **Tab Terminal en la web** (xterm.js + fit + reconexión).
3. **Persistencia/reconexión** (scrollback replay, keep-alive, cleanup en detach).
4. **Sandbox-aware** (`docker exec -it` si la sesión es aislada).
5. **Auth del WS** (junto con la capa de auth del daemon remoto).
6. **N terminales / splits** por workspace.

## Decisiones a tomar antes de codear

1. **`node-pty`** (dep nativa) — sí/no. Recomendado sí: estándar, aislado, sin él
   no hay terminal interactivo real.
2. **WS a mano vs `ws`** — recomendado `ws` (si ya cruzamos con node-pty).
3. **PTY persistente vs efímero** — recomendado persistente (tmux-like) con cap.

## Conecta con

- [[omega-distributed]] — el modelo (workspace en el daemon) + la seguridad que hereda.
- [[omega-mission-control]] — la shell de tabs / cockpit sobre la que crece.
- [[omega-conductor-reference]] — "terminal dedicado por workspace" está en la referencia.
- `omega-web-frontend` — Tauri como cáscara que lo bundlea.
