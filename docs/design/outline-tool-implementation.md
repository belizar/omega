# Outline tool — Implementación (spec para construir)

Spec prescriptivo para implementar la outline tool. El diseño y el porqué están
en `outline-tool-design.md` — leelo primero. Acá va el **cómo**, paso a paso.

Editá quirúrgico. No rompas tools existentes (read, edit, write, bash, grep,
ask_user) ni el bloqueo de `.env` (env-guard).

---

## Archivos

- **Crear** `src/outline/extract.ts` — la extracción pura (parsea y formatea).
- **Crear** `src/tools/outline.ts` — la `OutlineTool` que envuelve la extracción.
- **Modificar** `src/tools/read.ts` — el empujón estructural + flag `full`.
- **Modificar** `src/config.ts` — agregar `outlineThreshold` (env
  `OUTLINE_THRESHOLD`, default 200).
- **Modificar** `src/index.ts` — registrar la tool + una línea en el system prompt.

`typescript` ya está en node_modules (devDependency, lo usa tsc). Para que ande en
runtime (omega corre `node dist/index.js`), movelo a `dependencies` en
package.json (o confirmá que esté instalado). Importás con `import ts from
"typescript";`.

---

## 1. Extracción — `src/outline/extract.ts`

Dos funciones exportadas:

```ts
export function outlineFile(path: string, content: string): string
export function outlineDir(dirPath: string): string
```

### `outlineFile(path, content)`

1. Determiná el `ts.ScriptKind` por extensión: `.tsx`→TSX, `.ts`→TS, `.jsx`→JSX,
   `.js`→JS. Si no es TS/JS, devolvé un mensaje "outline solo soporta TS/JS".
2. `const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind);`
   (el `true` es clave: necesitás los parent nodes para `getStart`.)
3. Helpers de línea:
   - `const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;`
   - `const range = (node) => \`[${lineOf(node.getStart(sf))}-${lineOf(node.getEnd())}]\`;`
4. Recorré `sf.statements` (top-level). Por cada nodo, según su tipo:

   - **`ts.isImportDeclaration(node)`**: juntá los `moduleSpecifier` de todos los
     imports en UNA línea: `imports: ./a, ./b, ... [primera-última]`. (Agrupá
     todos los imports consecutivos del tope del archivo en una sola línea con el
     rango total.)
   - **`ts.isClassDeclaration(node)`**: emití `${mods}class ${name} ${range}`,
     después recorré `node.members` (con indentación) — `MethodDeclaration`,
     `GetAccessor`, `SetAccessor`, `Constructor`, `PropertyDeclaration` — cada uno
     con su firma + range (ver "renderSignature" abajo).
   - **`ts.isFunctionDeclaration(node)`**: `${mods}${renderSignature(node)} ${range}`.
   - **`ts.isInterfaceDeclaration(node)`**: `${mods}interface ${name} ${range}`.
   - **`ts.isTypeAliasDeclaration(node)`**: `${mods}type ${name} ${range}`.
   - **`ts.isEnumDeclaration(node)`**: `${mods}enum ${name} ${range}`.
   - **`ts.isVariableStatement(node)`**: por cada declaración en
     `node.declarationList.declarations`: `${mods}const ${name}${: type si hay} ${range}`.
   - Otros: ignorar.

5. Prependé la línea de cabecera: `${path} · ${totalLines} líneas`.

### `renderSignature(node)` (funciones/métodos)

- `mods` = modificadores presentes (`export `, `async `, `static `, `private `,
  etc.). Usá `ts.getModifiers(node)` (o `node.modifiers`) y mapeá los kinds. Para
  privados con `#`, el `node.name` ya es un `PrivateIdentifier` y
  `node.name.getText(sf)` da `#callLLM`.
- `name` = `node.name?.getText(sf)` (o `constructor`).
- `params` = `node.parameters.map(p => \`${p.name.getText(sf)}${p.type ? ": " + p.type.getText(sf) : ""}\`).join(", ")`.
- `returnType` = `node.type ? ": " + node.type.getText(sf) : ""`.
- Resultado: `${name}(${params})${returnType}`.

Todo **sintáctico**: usás `.getText(sf)` sobre los nodos de tipo, tal como están
escritos. No inferís nada (no hay type-checker).

### `outlineDir(dirPath)`

1. `readdirSync(dirPath)`. Separá archivos TS/JS de subdirectorios.
2. Por cada archivo TS/JS: parsealo (mismo `createSourceFile`), juntá las
   declaraciones **top-level que tengan modifier `export`** (clases, funciones,
   interfaces, types, enums, consts) — solo `kind + nombre`, sin miembros ni
   rangos. Renderealo: `${file}    ${exports.join(", ")}`.
3. Listá los subdirectorios por nombre: `(subdirs: a, b, c)` o `(sin subdirs)`.
4. Cabecera: `${dirPath} · ${nFiles} archivos`.

---

## 2. La tool — `src/tools/outline.ts`

Igual que las otras tools (extiende `Tool<Tin, Tout>`):

```ts
export type OutlineInput = { path: string };

export class OutlineTool extends Tool<OutlineInput, string> {
  // name: "outline"
  // description: "Muestra la estructura (firmas + rangos de línea) de un archivo
  //   TS/JS sin los cuerpos, o un mapa de exports de un directorio. Usalo antes
  //   de leer un archivo grande: outline para encontrar, read del rango para tocar."
  // schema: { path: string (archivo o directorio) }
  async execute(input) {
    // validar input, bloquear si isEnvFile(path)
    // statSync(path): si es directorio → outlineDir(path)
    //                 si es archivo → readFileSync + outlineFile(path, content)
    // try/catch → devolver "Error: ..." (las tools NUNCA tiran)
  }
}
```

---

## 3. El empujón en `read` — `src/tools/read.ts`

Agregá `full?: boolean` al schema y al tipo de input. En `execute`:

- Leé el contenido.
- Si: el archivo es TS/JS **Y** tiene más de `OUTLINE_THRESHOLD` líneas **Y** NO
  vino `offset` ni `limit` **Y** `full !== true`:
  - devolvé `outlineFile(path, content)` + un sufijo:
    "\n\n— Este archivo tiene N líneas. Pedí read con offset/limit de un rango, o
    full: true para leerlo entero. (outline para encontrar, read para tocar)"
- En cualquier otro caso (con offset/limit, o full:true, o archivo chico, o
  no-código): comportamiento normal de read actual.

El threshold viene de config (ver punto 4).

---

## 4. Config — `src/config.ts`

Agregá:
```ts
outlineThreshold: number;  // en la interface Config
// en validateEnv:
const outlineThreshold = parseInt(process.env.OUTLINE_THRESHOLD || "200", 10);
```
y pasalo al ReadTool (por constructor) para que sepa el umbral.

---

## 5. Registro — `src/index.ts`

- `haikuAgent.addTool(new OutlineTool())` junto a las otras.
- Pasale el `outlineThreshold` al `ReadTool`.
- En el SYSTEM_PROMPT, en la lista de tools, agregá:
  `- outline: vé la estructura de un archivo (firmas + rangos) sin leerlo entero.
   Usalo antes de read en archivos grandes; después read del rango que necesites.`

---

## 6. Tests unit (nuevos)

- `outlineFile`: sobre un TS de ejemplo con una clase con métodos (públicos y
  `#privados`), una función, un type → el output tiene las firmas con params/return
  y los rangos `[a-b]` correctos; los cuerpos NO aparecen.
- `outlineFile`: archivo no-TS → mensaje de no-soportado, no crashea.
- `outlineDir`: sobre un dir con varios archivos → lista cada archivo con sus
  exports top-level y los subdirs.
- `read` con empujón: archivo TS > threshold sin offset/limit → devuelve outline +
  el sufijo; con `full: true` → contenido completo; con offset/limit → el rango;
  archivo chico → contenido completo.

## 7. Verificación viva (obligatoria — "compila ≠ funciona")

- `tsc --noEmit` en 0, tests verdes.
- Corré omega y pedile algo que requiera entender un archivo grande real (ej:
  "explicame qué hace src/runner.ts"). Confirmá que:
  - el agente llama `outline` (o que un `read` de un archivo grande devolvió el
    outline) en vez de leer 400 líneas,
  - después hace `read` de un rango puntual,
  - las métricas de tokens del turno son MÁS BAJAS que leyendo el archivo entero.
- Pegá el output del outline de `src/runner.ts` para chequear que las firmas y
  los rangos están bien.

CRITERIO: outline produce firmas + rangos correctos; el read grande empuja al
outline; el agente navega "outline → read del rango" en una corrida real, con
menos tokens que antes.
