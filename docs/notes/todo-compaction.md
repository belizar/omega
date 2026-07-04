# ToDo — Issue #35: Compaction/poda dentro del loop

- [x] 1. `context-management.ts`: agregar `compactStaleReads()`
- [x] 2. `session.ts`: agregar `#workingContext`, `getContext()`, `compactWorkingContext()`, regeneración
- [x] 3. `index.ts`: usar `getContext()` + `compactWorkingContext()`
- [x] 4. Tests: `compactStaleReads` + actualizar session tests
- [x] 5. Verificar que typecheck y tests pasan