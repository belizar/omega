# Guía de diseño de la TUI de Omega

> Principios primero. Cada decisión de render se resuelve aplicando una regla de
> este doc, no improvisando. Si algo acá no cubre un caso, primero extendemos el
> principio, después renderizamos.

## 0. Para quién y para qué

La TUI de Omega la lee un ingeniero **mientras supervisa a un agente que trabaja
rápido**. No es una app que se contempla: es un flujo que se escanea. El lector
quiere responder tres preguntas en cada scroll, en menos de un segundo:

1. ¿Qué está haciendo el agente ahora?
2. ¿Qué decidió y qué cambió en mi código?
3. ¿Hay algo que requiere mi atención (error, pregunta, riesgo)?

Todo lo demás es contexto secundario. La guía optimiza para **escaneo veloz en el
scrollback**, no para densidad máxima ni para belleza. Cuando dos principios
choquen, gana el que sirva a esas tres preguntas.

## 1. Jerarquía visual: señal vs. ruido

El agente emite mucho: llamadas a tools, output de tools, su propio texto,
resultados, métricas. No todo pesa igual. Hay **tres capas**, y cada una tiene un
tratamiento visual fijo:

| Capa | Qué es | Tratamiento |
|------|--------|-------------|
| **Contenido** | El texto del agente: razonamiento, respuestas, planes | Foreground pleno. Es lo que el humano lee. |
| **Acción** | Qué tool se llamó y con qué (`read`, `edit`, `bash …`) | `cyan` para el nombre, argumento acortado. Una línea. |
| **Plomería** | Output crudo de tools, métricas, paths, ids, timestamps | `dim`/`gray`. Presente pero pisado. |

Regla operativa: **si el humano no lo va a leer palabra por palabra, va en dim.**
El output de un `bash` que salió bien es plomería; el texto donde el agente
explica qué encontró es contenido. Un `edit` que cambia código es acción **y**
merece resaltar el *qué cambió* (ver §7, diffs).

Corolario ya aplicado: mostrar `read apps/web/…/x.tsx` en vez del path absoluto
completo es bajar ruido sin perder señal. El path importa; el prefijo del cwd no.

## 2. Semántica de color (es ley, no sugerencia)

Omega ya define su paleta en `src/tui/theme.ts`. El problema histórico no es la
paleta, es que se aplica despareja. **Un color = un significado, siempre.** Si un
color empieza a significar dos cosas, perdió su valor de escaneo.

| Color | Significado único | Ejemplos |
|-------|-------------------|----------|
| `cyan` | Acción del agente / nombres de tool | `edit`, `bash`, `tool_search` |
| `gray` | Output crudo de tools | stdout de bash, resultados de grep |
| `dim` | Metadata y plomería | paths, ids, statusline, timestamps, recap |
| `green` | Éxito / confirmación | `✓ commit`, "sesión retomada" |
| `yellow` | Advertencia recuperable | reintento, degradación, "quedó incompleto" |
| `red` | Error / algo se rompió | tool falló, excepción del runner |
| foreground | Contenido del agente | su texto en markdown |

Antes de usar un color, preguntá: ¿este color ya significa otra cosa? Si sí, no lo
uses para esto. Los emojis siguen la misma disciplina: `✓` éxito, `⚠` warning,
`⏳`/`⟳` en curso, `⏹` interrumpido — no decorativos.

## 3. Progressive disclosure

Todo elemento tiene **dos formas**: una corta (default) y una larga (on-demand).
El default es siempre la corta. La larga se muestra sólo si el humano la pide
(`verbose`) o si el contenido es intrínsecamente la señal (un error, la respuesta
final).

| Elemento | Forma corta (default) | Forma larga (on-demand) |
|----------|----------------------|--------------------------|
| Tool call | `edit path/x.ts` | inputs completos |
| Tool result | resumen de 1 línea | output completo (`verbose`) |
| Archivo grande | outline (firmas) | cuerpo (`read` con offset/limit) |
| Sesión retomada | recap de N últimos mensajes | historial completo (existía) |
| Imagen | descripción preliminar | `vision_ask` puntual |

Este es el mismo patrón que ya usás en el outline y el tool_search, subido a
principio de UI. La regla para decidir el corte: **la forma corta debe bastar para
las tres preguntas del §0; la larga es para cuando el humano quiere auditar.**

## 4. Densidad y espaciado

Vertical es caro: cada línea en blanco empuja contexto fuera de la vista. Pero el
markdown sin aire es ilegible. La regla intermedia:

- **Una línea en blanco entre bloques semánticos** (párrafo, título, lista,
  bloque de código). Nunca dos seguidas.
- **Cero líneas en blanco dentro** de un mismo bloque.
- Los elementos de plomería (tool call + su result) van **pegados**, sin aire
  entre ellos: son una unidad.
- El contenido del agente (markdown) sí respira; la plomería no.

La pelea histórica de espaciados salió de tratar el markdown y la plomería con la
misma vara. No lo son: el markdown es para leer, la plomería es para escanear.

## 5. Layout estable

- **El editor vive fijo abajo; todo lo demás va al scrollback vía `printAbove`.**
  Nada escribe directo a `stdout` — eso pisa el editor. Es la invariante más
  importante de la TUI y ya está codificada en `Screen`.
- El streaming del texto del agente se hace token a token, pero el layout no
  "salta": la región viva se redibuja, el scrollback sólo crece.
- Anchos: nada asume 80 columnas. Todo lo que pueda ser ancho (tablas, paths,
  comandos) tiene que tener una estrategia para terminales angostas — truncar,
  envolver con indent, o acortar. Una tabla que se rompe es peor que una tabla
  fea.

## 6. Estados y feedback

El agente pasa por estados; cada uno tiene un signo visual inconfundible:

- **Pensando / esperando red:** spinner. Se detiene apenas empieza a llegar texto.
- **Streaming:** el texto aparece incremental, en foreground.
- **En curso, multi-paso:** `⏳ Continuando…` / `⟳ reintentando (n/3)…` en yellow.
- **Éxito:** `✓` en green, breve.
- **Advertencia recuperable:** `⚠` en yellow, con qué pasó y qué se hizo.
- **Error:** `red`, con el mensaje real, no un genérico.
- **Interrumpido por el humano:** `⏹`, sin drama.
- **Turno vacío / degenerado:** nunca silencioso. Se reintenta y se avisa.

El **statusline** (`~ ctx: … tk · n tools · in/out · dur · $`) es plomería pura:
siempre `dim`, siempre al pie del turno, nunca compite con el contenido. Es para
la pregunta "¿cuánto me está costando?", no para leer al pasar.

## 7. Casos que merecen tratamiento propio

- **Edits:** un `edit` no debería mostrarse sólo como "edité X". Lo valioso es el
  *diff* — qué líneas cambiaron. Es acción + contenido: la línea de acción en
  cyan, y debajo un diff compacto (verde/rojo) de lo que cambió. (Pendiente.)
- **Tablas:** cap de ancho por celda + wrapping, nunca desbordar. (Pendiente.)
- **Output de bash largo:** truncar en la forma corta con "… (N líneas más,
  verbose)"; nunca volcar 200 líneas de build al scrollback por default.
- **Bloques de código en el markdown del agente:** monoespaciado, con un margen
  visual claro respecto al texto.

## 8. Anti-patrones (lo que ya nos mordió)

- Escribir directo a `stdout` en vez de `printAbove` → pisa el editor.
- Tratar markdown y plomería con el mismo espaciado → o queda apretado o queda
  ventoso.
- Un color con dos significados → el escaneo deja de funcionar.
- Mostrar la forma larga por default → ahoga la señal en detalle.
- Paths absolutos, ids completos, timestamps largos en foreground → ruido.
- Fallar en silencio (turno vacío, red caída) → el humano no sabe si murió o
  piensa. Todo estado tiene que ser visible.
- Asumir ancho de terminal → se rompe en angosto.

## 9. Checklist para agregar un elemento nuevo a la TUI

1. ¿A qué capa pertenece — contenido, acción o plomería? De ahí sale el color.
2. ¿Cuál es su forma corta? ¿Y la larga? El default es la corta.
3. ¿El color que uso ya significa otra cosa?
4. ¿Respeta el espaciado del §4 (aire entre bloques, pegado dentro de una unidad)?
5. ¿Pasa por `printAbove`? ¿Sobrevive a una terminal angosta?
6. Si es un estado, ¿es inconfundible y nunca silencioso?
