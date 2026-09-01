# quality-tests

Verificar que los cambios pasan las pruebas y no rompen el build.

## Pasos

1. Identificar scripts disponibles en el proyecto.
2. Ejecutar typecheck o build cuando exista.
3. Ejecutar tests unitarios o integracion disponibles.
4. Si no hay tests, reportarlo como brecha de calidad.
5. Si falla un comando, diagnosticar causa y volver a `sdd-apply`.

## Comandos Comunes

- `pnpm test`
- `npm test`
- `bun test`
- `pnpm build`
- `bun run build`
- `tsc --noEmit`

## Salida

- Scripts detectados.
- Comandos ejecutados.
- Resultado.
- Fallos reproducibles.
- Accion siguiente.
