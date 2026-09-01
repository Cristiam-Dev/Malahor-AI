# sdd-quality

Ejecutar calidad antes de verificar el resultado final.

## Pasos

1. Ejecutar build o typecheck disponible.
2. Ejecutar tests disponibles.
3. Revisar duplicacion o complejidad introducida.
4. Revisar riesgos para SonarQube: bugs, code smells, seguridad y cobertura.
5. Si falla, volver a `sdd-apply`.

## Salida

- Comandos ejecutados.
- Resultado de calidad.
- Fallos y correcciones necesarias.
- Proxima fase: `sdd-verify` solo si calidad pasa.
