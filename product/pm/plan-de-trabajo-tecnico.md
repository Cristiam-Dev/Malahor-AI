# Plan de trabajo tecnico - malahor-ai

## Estado general

Diseno completo cerrado. Construccion iniciada con Fase 1 base funcional implementada y validada en sandbox WSL/Ubuntu. El entorno real del usuario no debe tocarse durante desarrollo; usar scripts sandbox.

## Fase 1 - Base funcional MVP

Objetivo: instalar Malahor en WSL/Ubuntu con OpenCode y memoria Mnemo funcional.

| ID | Tarea | Estado |
|---|---|---|
| T-01 | Crear estructura base del repo npm | Completado |
| T-02 | Configurar pnpm workspaces, TypeScript y Bun | Completado |
| T-03 | Implementar `src/cli/core/paths.ts` | Completado |
| T-04 | Implementar `src/cli/core/detector.ts` | Completado |
| T-05 | Implementar `src/cli/core/backup.ts` | Completado |
| T-06 | Implementar `src/cli/core/injector.ts` | Completado |
| T-07 | Implementar `src/mnemo/db.ts` | Completado |
| T-08 | Implementar `src/mnemo/tools.ts` | Completado |
| T-09 | Implementar `src/mnemo/index.ts` | Completado |
| T-10 | Implementar `src/cli/commands/install.ts` | Completado |
| T-11 | Implementar `src/cli/index.ts` | Completado |
| T-12 | Crear `assets/opencode/OPENCODE.md` | Completado |
| T-13 | Probar instalacion local en WSL/Ubuntu | Completado |

## Fase 2 - Multi-plataforma y mantenimiento

Objetivo: estabilizar soporte de diagnostico y ciclos de vida.

| ID | Tarea | Estado |
|---|---|---|
| T-14 | Implementar `doctor` | Completado |
| T-15 | Implementar `uninstall` | Completado |
| T-16 | Implementar `update` | Completado |
| T-17 | Soporte Linux nativo | Completado |
| T-18 | Soporte Mac | Completado |
| T-19 | Soporte Windows PowerShell | Completado |

## Fase 3 - Skills y assets

Objetivo: entregar valor diferencial sobre orquestacion, SDD y calidad.

| ID | Tarea | Estado |
|---|---|---|
| T-20 | Crear skills `sdd-*` | Completado |
| T-21 | Crear skill `pattern-advisor` | Completado |
| T-22 | Crear skills de calidad | Completado |
| T-23 | Crear skills git | Completado |
| T-24 | Crear `vault-template` | Completado |
| T-25 | Crear personas neutral y plantilla custom | Completado |

## Fase 4 - Publicacion

Objetivo: publicar paquete npm publico y dejar repositorio GitHub listo.

| ID | Tarea | Estado |
|---|---|---|
| T-26 | README publico completo | Pendiente |
| T-27 | `.npmignore` | Completado |
| T-28 | GitHub Actions CI | Pendiente |
| T-29 | Preparar version `0.1.0` | Pendiente |
| T-30 | Publicar en npm | Pendiente |

## Prioridad inmediata

Continuar con `uninstall`, `update`, Graphify funcional, soporte multiplataforma y catalogo de skills/assets. Antes de tocar el entorno real, validar siempre con `bun run dev:sandbox` y `bun run doctor:sandbox`.
