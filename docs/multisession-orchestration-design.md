# Proyecto 2 — Orquestación Multi-Sesión

**Estado:** scope + preguntas abiertas. **Diseño NO cerrado** — depende del
Proyecto 1 (`dossier-design.md`) y varios componentes todavía no están bajados a
concreto. No codear hasta cerrarlos.

**Dependencia:** se apoya entero sobre el dossier del Proyecto 1. P1 acota el
contexto dentro de una sesión; P2 agrega contexto **fresco** por milestone
encima de eso.

---

## 1. Por qué existe (si P1 ya acota el contexto)

El dossier de P1 hace viable una single session larga con contexto acotado. P2
agrega lo que P1 **no** da:

- **Fresh eyes.** Aun con contexto acotado, una sesión muy larga acumula drift
  (el modelo lleva 500 steps "en personaje"). Re-leer el dossier en frío, en una
  sesión nueva, atrapa cosas que el modelo en vuelo ya normalizó.
- **Válvula de recuperación.** En single-session, una evicción que tiró algo
  necesario te penaliza el resto de la sesión (re-descubrimiento). El reset de
  contexto fresco de P2 es el punto natural para reenganchar.
- **Checkpoints deliberados** para verificación/commit por milestone.

Son **secundarios**: el grueso del valor (contexto acotado, costo, la mayoría
del rot) lo da P1 solo. P2 es refinación, no fundación.

**Qué se pierde sin P2:** nada esencial — tenés P1, un sistema completo. P2 es
opt-in para tareas grandes o cuando querés resets explícitos.

---

## 2. Componentes (todos a diseñar)

### 2.1 Planner *(abierto)*

Una call que descompone la tarea en hitos ordenados. Cada hito: objetivo +
criterio de aceptación + archivos probables. **No** se le pide "¿cuántas
sesiones?" — se le piden hitos.

**A diseñar:** formato del plan; cómo se ve un **buen** hito vs uno malo
(demasiado grueso = todo en uno; demasiado fino = overhead de migración);
ejemplos few-shot; cómo se comunica al executor. *(Catch de omega #1.)*

### 2.2 Executor + stopping condition *(abierto)*

Por cada hito, un `Runner.run()` con contexto fresco
(`system + plan + dossier-fold + subtask`), corriendo hasta cumplir el criterio
de aceptación o agotar un budget de steps/tokens.

**A diseñar:** ¿quién evalúa "compila + pasa test X"? ¿El agente en un turno
final, o una call de verificación aparte? Si el agente dice "listo" pero el test
no pasa, ¿se reabre el hito o se crea uno nuevo? *(Catch de omega #2.)*

### 2.3 Ritual de migración *(abierto)*

El borde del hito. Versión "de borde" de la evicción de P1: acá el agente
**justifica** qué cruza al próximo hito (a diferencia de la evicción automática
de P1). Agrega los ops `migrate` y `targetMilestone`, y la justificación como
desempate.

**A diseñar:** ¿es una call dedicada o el propio agente en el último turno? ¿con
qué prompt y qué contexto (dossier viejo + entries nuevas + plan)? ¿cómo se
aplica budget + justificación en la práctica para que no migre todo ni nada?
*(Catch de omega #4.)*

### 2.4 Mecanismo milestone : sesión (1:N) *(esbozado)*

Un milestone puede necesitar varias sesiones (si revienta el budget de steps).
Mecanismo: el orquestador **estampa** cada `Runner.run` con el `milestone`
actual; las N sesiones del mismo milestone comparten ese número; el evento
`milestone_advance` dispara **solo** cuando el criterio de aceptación pasa.
*(Catch de omega #6 — hay que hacerlo explícito en código.)*

### 2.5 Re-planning *(abierto)*

Un hito puede revelar que el plan estaba mal. El executor necesita poder señalar
"replan, encontré esto" y el orquestador re-corre el planner con el dossier como
input. Sin esto, el sistema marcha contra el acantilado.

---

## 3. Qué agrega P2 al schema de P1

Nada que rompa — solo **suma** (el schema de P1 ya dejó los huecos opcionales):

- Ops nuevos: `migrate`, `milestone_advance`.
- Campos ya presentes y opcionales: `milestone`, `targetMilestone`, `state:
  "migrated"`, `Entry.justification`.

Por eso P1 se puede construir y shippear sin tocar nada de P2.

---

## 4. Preguntas abiertas (resumen)

1. Formato del plan + buenos/malos hitos (planner).
2. Quién y cómo chequea el criterio de aceptación (stopping condition).
3. El ritual de migración como call concreta (prompt + contexto + budget).
4. Re-planning: cómo el executor lo dispara.

Cerrar estas en papel **antes** de codear P2 — igual que hicimos con la emisión
de P1. La que más puede mover cosas es el planner; arrancar por ahí.
