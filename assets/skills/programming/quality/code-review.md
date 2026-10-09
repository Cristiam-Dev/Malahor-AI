# programming/quality/code-review

## Usar Cuando

- Revisar diff, PR, cambios generados por IA o refactors.

## Versiones y compatibilidad

- Ajustar severidad al contexto: prototipo, producto, libreria, seguridad, infra o datos.
- No bloquear por preferencias personales si no afectan calidad, coherencia o riesgo.

## Checklist profesional

- Correctitud contra requisitos y casos borde.
- Seguridad: authz, secrets, input validation, injection, supply chain.
- Concurrencia/idempotencia/transacciones donde aplique.
- Arquitectura: boundaries, acoplamiento, ownership.
- Mantenibilidad: nombres, tamaño, duplicacion, complejidad.
- Performance: queries, renders, bundles, event loop, memoria.
- Observabilidad: logs, metricas, errores accionables.
- Tests: nivel correcto y fallos relevantes.
- Documentacion/contratos/migraciones actualizadas.
- Cambios no relacionados o riesgos de rollback.

## Salida recomendada

- Priorizar P0/P1/P2/P3.
- Cada hallazgo: ubicacion, problema, impacto, fix sugerido.
- Separar bloqueantes de mejoras opcionales.

## Anti-patrones

- Comentarios vagos (`mejorar`, `limpiar`).
- Reescribir estilo personal sin beneficio.
- Ignorar riesgos por confiar en generacion IA.

## Fuentes canonicas

- Google Engineering Practices - Code Review: https://google.github.io/eng-practices/review/
- GitHub Pull Request Reviews: https://docs.github.com/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests
