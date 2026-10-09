# specialty-quality

Guia de especialidad para calidad: testing, cobertura, code review, accesibilidad, rendimiento, seguridad basica y gates de release.

## Usar Cuando

- La tarea pide tests, coverage, code review, auditoria, performance o accesibilidad.
- Se prepara una release, publicacion npm, migracion o cambio con riesgo de regresion.
- `malahor-ai context detect` sugiere `specialty-quality`.

## Preguntas Guia

1. Que comportamiento critico debe quedar protegido por tests?
2. Que regresion seria mas costosa para el usuario o el negocio?
3. Que validaciones automatizadas ya existen y cuales faltan?
4. Que se puede verificar con unit, integration, e2e, smoke o analisis estatico?
5. Que parte necesita revision humana (seguridad, accesibilidad, UX, datos)?
6. Que evidencia deja la tarea al cerrarse?

## Puntos de Revision

- Tests: cubrir reglas de negocio, contratos, errores y flujos criticos antes que cobertura superficial.
- Build: typecheck, lint, tests y empaquetado deben correr en CI o sandbox antes de release.
- Accesibilidad: teclado, foco, labels, contraste y estados no dependientes solo del color.
- Performance: evitar N+1, bundles innecesarios, renders costosos y listas sin virtualizar.
- Seguridad: secretos, permisos, input validation, dependency risk y scripts de instalacion.
- Dif: revisar archivos tocados, artefactos generados y cambios no relacionados.

## Anti-Patrones

- Medir solo porcentaje de cobertura sin proteger flujos importantes.
- Agregar snapshots grandes que no detectan errores reales.
- Ignorar tests flaky o fallos intermitentes.
- Publicar sin revisar el contenido del paquete (`npm pack --dry-run` o equivalente).
- Resolver hallazgos bajando reglas sin entender el riesgo.
- Mezclar refactors amplios con features sin validacion incremental.

## Salida

- Plan de validacion por tipo de prueba.
- Comandos ejecutados o recomendados y resultados esperados.
- Riesgos residuales y mitigaciones.
- Checklist de cierre para el usuario.
- Decisiones o bugs para guardar en Mnemo.

## Integracion Con SDD

- `sdd-quality` es obligatoria antes de `sdd-verify`.
- Si calidad falla, volver a `sdd-apply` antes de cerrar.
- Archivar en Mnemo que se valido, que quedo pendiente y por que.
