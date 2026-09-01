# SDD - Specification Driven Development

Usar este flujo para cambios no triviales: features nuevas, refactors amplios, cambios de arquitectura, integraciones, migraciones o modificaciones con riesgo de regresion.

## Fases

1. `sdd-init`
2. `sdd-explore`
3. `sdd-propose`
4. `sdd-spec`
5. `sdd-design`
6. `sdd-tasks`
7. `sdd-apply`
8. `sdd-quality`
9. `sdd-verify`
10. `sdd-archive`

## Reglas

- No saltar `sdd-quality`.
- Si calidad falla, volver a `sdd-apply` antes de verificar.
- Guardar decisiones importantes en Mnemo.
- Usar Graphify antes de leer muchos archivos raw.
- No crear artefactos SDD dentro del repo objetivo salvo pedido explicito del usuario.
