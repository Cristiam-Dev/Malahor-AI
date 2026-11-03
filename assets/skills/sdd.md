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

- Antes de presentar un plan, aplica `planificacion-verificada`: preflight
  read-only, mapa de impacto y slice pequeño.
- No saltar `sdd-quality`.
- Si calidad falla, volver a `sdd-apply` antes de verificar.
- Guardar decisiones importantes en Mnemo.
- Usar la capacidad de contexto de codigo configurada o busquedas dirigidas antes de leer muchos archivos raw.
- Leer y mantener artefactos SDD mediante `docs_*` en la raiz externa del proyecto.
- Interpretar la solicitud documental natural, buscar el artefacto antes de crear y gestionar `ifMatch`/`ifNoneMatch` sin pedir versiones al usuario.
- No crear documentacion SDD dentro del repo objetivo ni usar filesystem/Obsidian MCP como fallback.

## Presupuesto de análisis

Máximo tres ciclos de exploración o análisis por fase. Si al tercer ciclo no
hay evidencia suficiente, entrega el bloqueo con lo que falta y la siguiente
acción concreta. No repitas la misma búsqueda con otra formulación.
