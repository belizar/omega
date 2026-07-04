# Pruebas manuales — SIGINT (#11) y ask_user (#10)

## Preparación

```bash
npm run build
npm run dev
```

Todas las pruebas asumen que estás en el prompt `>` de omega.

---

## #11 — SIGINT para interrumpir al agente

### Prueba 1: Interrumpir durante una llamada larga al LLM

1. Escribí un prompt que haga que el agente genere mucho texto:

```
Escribí un poema épico de 500 líneas sobre la historia de la computación.
```

2. Apenas empiece a salir texto (o durante el streaming), apretá **Ctrl+C**.
3. **Esperado**: Sale `⏹ Interrumpido por el usuario.` y volvés al prompt `>`. La sesión sigue viva, el historial se preserva.
4. **Verificá**: Escribí `hola` y confirmá que el agente responde normalmente.

### Prueba 2: Interrumpir durante ejecución de tools

1. Pedí algo que dispare varias tools:

```
Leé todos los archivos .ts del proyecto y hacé un resumen
```

2. Mientras se están ejecutando las tools (ves `> read ...` o `> bash ...`), apretá **Ctrl+C**.
3. **Esperado**: Se interrumpe limpiamente, volvés al prompt. La sesión no se pierde.
4. **Verificá**: Volvé a escribir cualquier cosa y confirmá que el agente responde.

### Prueba 3: Ctrl+C en el prompt (sin agente corriendo)

1. Con el agente en reposo (prompt `>`), apretá **Ctrl+C**.
2. **Esperado**: Sale del programa (comportamiento de siempre). Esto no debe cambiar.

### Prueba 4: Interrumpir y seguir conversación

1. Escribí:

```
Hacé un ls y después leé AGENT.md
```

2. Apretá **Ctrl+C** mientras procesa.
3. **Esperado**: Interrupción limpia, prompt disponible.
4. Escribí:

```
Cuáles son las tools disponibles?
```

5. **Esperado**: El agente responde normalmente, usando el contexto de la conversación (no perdió la memoria de la sesión).

---

## #10 — ask_user (modo plan / confirmación)

### Prueba 5: Confirmación antes de acción destructiva

1. Escribí:

```
Borrá el archivo src/tools/ask-user.ts
```

2. **Esperado**: El agente invoca `ask_user` pidiendo confirmación. Ves algo como:

```
> ask_user ...
  = (confirmación recibida)

⚠ ¿Querés que borre el archivo src/tools/ask-user.ts?

> Responder (Enter para enviar, vacío para cancelar): _
```

3. Escribí `no` y apretá Enter.
4. **Esperado**: El agente recibe "no" como respuesta y **no borra** el archivo. Debería decir algo como "Ok, no borro nada".
5. **Verificá**: `ls src/tools/ask-user.ts` sigue existiendo.

### Prueba 6: Confirmación afirmativa

1. Creá un archivo temporal:

```bash
echo "test" > /tmp/omega-test-file.txt
```

2. En omega:

```
Borrá el archivo /tmp/omega-test-file.txt
```

3. Cuando pregunte, respondé `sí` o `dale`.
4. **Esperado**: El agente borra el archivo.
5. **Verificá**: `ls /tmp/omega-test-file.txt` ya no existe.

### Prueba 7: Respuesta vacía (cancelar)

1. Escribí:

```
Instalá el paquete cowsay con npm
```

2. Cuando aparezca la confirmación, apretá **Enter** sin escribir nada.
3. **Esperado**: El agente interpreta la respuesta vacía como cancelación y no instala nada.
4. **Verificá**: `npx cowsay --version` no debería mostrar nada (o error).

### Prueba 8: Pedido de elegir entre opciones

1. Escribí:

```
Tengo tres opciones de nombre para una variable: userList, allUsers, accountCollection. Cuál me recomendás?
```

2. **Esperado**: El agente debería responder sin usar `ask_user` (no es una acción destructiva). Si usa `ask_user`, respondé con tu elección y verificá que procesa la respuesta.

### Prueba 9: El agente NO pide confirmación para tareas rutinarias

1. Escribí:

```
Leé el archivo package.json
```

2. **Esperado**: El agente lee el archivo directamente, **sin** pedir confirmación.
3. **Verificá**: Ves el contenido del archivo sin ninguna interrupción.

### Prueba 10: ask_user + SIGINT combinados

1. Escribí:

```
Instalá three.js con npm
```

2. Cuando aparezca el prompt de confirmación (`> Responder ...`), apretá **Ctrl+C**.
3. **Esperado**: Interrumpe la pausa y vuelve al prompt principal. Es como si hubieras cancelado la confirmación.
4. **Verificá**: `ls node_modules/three` no existe (o `npm ls three` no lo muestra).

---

## Cosas a verificar en general

- Después de cada interrupción con SIGINT, la línea de métricas (`~ ctx: ...`) debería aparecer.
- El spinner de "Pensando" no debería quedar colgado después de SIGINT ni después de ask_user.
- El costo acumulado de la sesión se sigue mostrando correctamente.
