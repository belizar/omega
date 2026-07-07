# Bitácora — Omega Interviews

Registro de decisiones y experimentos del harness de evals. Lo importante no es
el resultado de una corrida, es *qué aprendimos y qué decidimos*. Append-only.

---

## Decisiones

- **JD = mejorar el harness** (no elegir un modelo). La variable es omega; el
  modelo se congela. → eval como A/B de regresión (`--label` + `--omega`).
- **Framing = entrevista de trabajo** (full-commit): candidate / question / rubric
  / round / verdict / transcript. Codifica la metodología correcta.
- **Candidate congelado = `deepseek/deepseek-v4-flash`.** El modelo flaco es un
  instrumento más sensible (necesita el andamiaje → deltas grandes) y ~5× más
  barato. Tesis de Benja: mejorar para el flaco ≈ mejora para el gordo (válido
  para capacidad; puede invertirse para andamiaje — ver Terminal-Bench).
- **Juez LLM pospuesto.** No sumar un instrumento que también hay que validar
  hasta que el resto esté sólido. Si se agrega, su mejor uso es analista de
  failure modes leyendo el transcript, NO reemplazar la rubric objetiva.
- **Costo es una feature:** `--budget` corta antes de pasarse. Construir el
  harness cuesta ~$0 (se desarrolla contra el modelo más barato).

---

## Experimentos

### EXP-1 · Calibración con modelo fuerte (deepseek-v4-pro)
- **Hipótesis:** las questions ejercen el harness de forma distinta.
- **Setup:** pro, k=1, 3 questions (demo, feat-mode, nav-negatives).
- **Resultado:** 3/3 pasan; trayectoria discrimina (3 vs 7 vs 9 pasos).
- **Conclusión:** las questions sirven como instrumento de esfuerzo; con modelo
  fuerte la correctitud satura.

### EXP-2 · Calibración con modelo flaco (deepseek-v4-flash)
- **Hipótesis:** el flaco es más sensible al harness.
- **Setup:** flash, k=1, 3 questions.
- **Resultado:** pasa las 3 igual, pero con mucho más esfuerzo (feat-mode: pro 7
  pasos/1.5k tok-out vs flash 15/12k). ~5× más barato.
- **Conclusión:** flash es mejor candidate congelado. Su failure mode no es
  equivocarse: es **no converger** (thrashing).

### EXP-3 · Trap de correctitud (median-parity, flash)
- **Hipótesis:** una trampa (fix naive rompe caso de borde) hace fallar a flash.
- **Setup:** flash, k=3, question median-parity.
- **Resultado:** flash NO cae (arregla bien la mediana); pero 1 de 3 timeouteó
  (300s). Varianza enorme: 6 / 17 / timeout.
- **Conclusión:** la trampa no discrimina por correctitud, pero confirma que el
  failure mode real es convergencia. **Bug del harness encontrado:** un timeout
  se contaba como pass → arreglado (verdict `timeout` propio).

### EXP-4 · A/B del nudge "sé decidido" (antes vs despues)
- **Hipótesis:** un nudge de "terminá, no sobre-explores" en el system prompt
  reduce el thrashing.
- **Setup:** flash, k=5, 4 questions. `antes` = baseline; `despues` = + nudge.
- **Resultado:** parecía ayudar (demo-bugfix 4/5→5/5, timeout 1→0). Pero la
  eficiencia fue mixta (2 ▲, 2 ▼).
- **Conclusión:** sospechoso — dentro del ruido conocido. NO shippear todavía.
  → correr un A/A antes de confiar.

### EXP-5 · A/A — piso de ruido (antes vs antes2)
- **Hipótesis:** ¿cuánto se mueven los números SIN cambiar nada?
- **Setup:** flash, k=5, 4 questions, baseline dos veces.
- **Resultado:** el A/A se movió **igual o más** que el A/B. El timeout de
  demo-bugfix también desapareció solo (1→0); los tokens bajaron *más* en el A/A
  (▼547) que en el A/B (▼312).
- **Conclusión:** **el efecto del nudge era 100% ruido.** A k=5, el piso de ruido
  ≥ el efecto. El nudge se revirtió. Lección: SIEMPRE correr un A/A antes de
  confiar en un A/B. **Causa raíz del ruido:** omega no setea `temperature` → usa
  el default alto (~1.0) → máxima varianza. Palanca #1: bajar la temperatura.

### EXP-6 · Temperatura (temp 0)
- **Hipótesis (mía):** temp 0 reduce la varianza corrida-a-corrida (era mi
  "palanca #1"). Efecto grande → detectable a k=5.
- **Setup:** flash, k=5, 4 questions, `--temp 0`. Comparado vs `antes` y contra el
  piso de ruido del A/A (EXP-5).
- **Resultado:** temp0 = 20/20 pass, 0 timeouts. Pero las medianas se movieron
  DENTRO del ruido del A/A (▲1/▼1, igual que antes vs antes2), y **la dispersión
  NO se apretó**: feat-mode temp0 [6,8,9,9,12] vs baseline [2,8,8,9,9]; nav temp0
  [6,6,6,8,8] vs [6,6,6,9,9]. Comparables. Los "0 timeouts" no se distinguen del
  A/A (antes2 también tuvo 0).
- **Conclusión: MI HIPÓTESIS ERA FALSA.** Temp 0 no domó la varianza. Razón (el
  aprendizaje real): en evals **agénticos** la varianza no viene del sampling de
  tokens sino del **branching de la trayectoria multi-paso** — diferencias
  minúsculas temprano compuestan sobre 6-17 pasos en caminos muy distintos, y
  temp 0 (que además en MoE no es determinista) no lo evita. La intuición
  "poné temp 0" funciona para completions de un tiro, NO para agentes.
  → El `--temp` queda como feature opcional (útil), pero NO se cambia el default.
  El camino real a un instrumento confiable es **más k** (aceptar el costo) y/o
  **cambios de efecto grande**, no bajar la temperatura.

### EXP-7 · k=30 en feat-mode → INVÁLIDO (bug de aislación)
- **Hipótesis:** k=30 aprieta la estimación (√6 ≈ 2.4×) → más medible.
- **Setup:** flash, k=30, feat-mode.
- **Resultado:** patrón sospechoso (round 1-2: 13/18 pasos, uno falló; round 3-30:
  4-6 pasos parejo). Investigación: el **source del worktree de feat-mode fue
  modificado** (le agregaron `mode`). Firma de contaminación: las copias
  temporales tardías arrancaron pre-resueltas.
- **Causa:** una corrida limpia NO leakea (usa paths relativos → temp). Pero el
  **bash del agente puede escapar del temp**: un flash que thrashea puede correr
  un `find` amplio, ubicar el source real y editarlo. Raro, gatillado por
  thrashing. El clasificador no bloquea `find`/`edit` a un path cualquiera.
- **Conclusión: EXP-7 descartado.** **Fix:** las corridas copian desde un
  **snapshot pristino inmutable** (no del source vivo) → los datos quedan
  blindados aunque el source se corrompa. + chequeo de integridad que avisa el
  leak. **Fix real pendiente:** correr el agente en **contenedor** (aislamiento
  del filesystem) — confirma la decisión abierta del design doc. Solo feat-mode
  se contaminó; el dato de feat-mode en EXP-1..6 queda como sospechoso.

### EXP-8 · k=30 en feat-mode, con aislación blindada (re-run)
- **Setup:** flash, k=30, feat-mode, snapshot pristino. Chequeo de integridad: OK
  (source intacto → fix confirmado).
- **Resultado:** 30 corridas: 28 pass, 2 fail, 0 timeout. Pasos (pass) mediana=9,
  spread mayormente 8-13. Subgrupos de 5 → medianas 10/9/9/10/11 (rango 9-11).
- **Conclusión (dos):**
  1. **k=30 SÍ es más medible.** A k=5 la mediana bailaba 9-11 (±1-2); a k=30 es
     un 9 estable. Un cambio de harness necesita mover la mediana >~2 pasos para
     verse a k=5; a k=30 se detectan shifts más chicos. (Instinto de Benja: ✓.)
  2. **La varianza "enorme" de antes estaba INFLADA por la contaminación.** feat-mode
     limpio es ~9 pasos, tight (8-13), 0 timeouts — NO el 6/17/timeout ni el 4-6
     del run sucio. El instrumento es más usable de lo que parecía; el piso de
     ruido real es más chico. La aislación no solo limpió el dato: reveló que el
     ruido que nos asustó era en parte un artefacto del leak.

### EXP-9 · Cambio de EFECTO GRANDE — primar el contexto con los archivos (control positivo)
- **Hipótesis:** un cambio grande SÍ se detecta (control positivo del instrumento).
  Inyectar el contenido de los archivos de código chicos del cwd en el contexto
  inicial → el agente no gasta pasos leyéndolos para orientarse → mediana baja.
- **Setup:** flash, k=30, feat-mode. Baseline = `k30-clean` (mediana 9).
  Variante = build con `loadWorkdirFiles()` (capeado: top-level, <2KB, ≤8 files).
- **Resultado:** baseline pass 28/30, medSteps=9, medTokIn=43.486. Primed pass
  **30/30**, medSteps=**7**, medTokIn=**33.184**. Δ pasos −2, Δ tokens-in **−24%**,
  fails 2→0. Distribución de pasos claramente corrida hacia abajo.
- **Conclusión: CONTROL POSITIVO ✓ — el instrumento detecta efectos reales.** Lo
  que ni el nudge ni temp lograron. Confirma que la herramienta sirve. **Lección
  de método:** tokens-in es mejor métrica que la mediana de pasos (continua vs
  discreta; el Δ de tokens es inequívoco, el de pasos roza el ruido). **PERO** el
  cambio NO es shippeable (crítica de Benja: inyectar archivos no escala a un
  monorepo). Sirvió solo de control positivo. La versión escalable de "orientar
  al agente" es AGENT.md → EXP-10. loadWorkdirFiles se revierte.

### EXP-10 · AGENT.md vs sin AGENT.md (la versión escalable, en curso)
- **Hipótesis:** un AGENT.md curado (qué es el repo, estructura, cómo agregar un
  stat) orienta al agente igual que el priming, pero **escala** (tamaño fijo,
  sirve en un monorepo). Pregunta real para Medra: ¿cuánto rinde un buen AGENT.md?
- **Setup:** flash, k=30, feat-mode. Build SIN loadWorkdirFiles (revertido).
  Baseline = `k30-clean` (sin AGENT.md). Variante = repo + AGENT.md.
- **Resultado:** _(pendiente)_
