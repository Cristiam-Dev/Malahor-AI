# quality

Ejecutar una revision de calidad antes de cerrar cambios implementados.

## Usar Cuando

- Una fase `sdd-quality` este activa.
- Se haya completado una implementacion o refactor.
- El usuario pida revisar calidad, tests, cobertura, duplicados o SonarQube.

## Alcance

- Build o typecheck.
- Tests disponibles.
- Cobertura cuando exista herramienta configurada.
- Duplicacion y complejidad introducida.
- Preparacion para SonarQube.

## Orden Recomendado

1. `quality-tests`
2. `quality-coverage`
3. `quality-duplicates`
4. `quality-sonarqube`

## Salida

- Comandos ejecutados.
- Resultado por area.
- Bloqueadores.
- Riesgos residuales.
- Recomendacion: pasar a `sdd-verify` o volver a `sdd-apply`.
