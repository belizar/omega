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

### EXP-6 · Temperatura (en curso)
- **Hipótesis:** bajar la temperatura de omega reduce el ruido Y mejora la
  confiabilidad (un coding agent a temp ~1 es menos determinista). Efecto
  potencialmente grande → detectable incluso a k=5.
- **Setup:** flash, k=5, 4 questions. `antes` = temp default; `temp0` = temp 0.
- **Resultado:** _(pendiente)_
- **Conclusión:** _(pendiente)_
