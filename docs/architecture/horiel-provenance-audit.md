# Horiel — auditoría preliminar de procedencia

**Estado:** preliminar / NO-GO para implementar

**Fecha:** 2026-10-31

**Alcance:** repositorio `malahor-ai`; no incluye dictamen jurídico ni inspección de
equipos, conversaciones o fuentes externas no versionadas.

## Propósito

Separar tres hechos que no deben confundirse:

1. el código de memoria que hoy existe en Malahor;
2. los requisitos propios aprobados para Horiel;
3. la evidencia necesaria para afirmar que una implementación nueva puede
   distribuirse sin copiar material ajeno.

Esta auditoría no autoriza renombrar `src/mnemo` a `src/horiel`, reutilizar sus
tests como especificación literal ni concluir que el historial Git prueba por sí
solo autoría independiente.

## Evidencia revisada

- `LICENSE`: software propietario, copyright 2026 Cristiam-Dev.
- `THIRD_PARTY_NOTICES.md`: declara `jsonc-parser` y `symgraph`; no contiene un
  aviso asociado al motor de memoria.
- `package.json`: publica `dist` y `assets`; compila `src/mnemo/index.ts` hacia
  `dist/mnemo` y conserva `mnemo` como keyword.
- Historial Git de las superficies de memoria. Hitos observados:
  - `7e38f63`: base inicial del repositorio.
  - `e69de72`: administración segura de Mnemo.
  - `035e893`: spike SQLite/FTS5.
  - `03dd1aa`: engine SQLite v2 y MCP.
  - `1e172f7`: migrador JSON → SQLite.
  - `1a6980e`: CLI y administración v2.
- Inventario y búsqueda textual de nombres, imports, rutas, licencias y
  referencias de inspiración en fuente, tests, assets y documentación.
- Documentación histórica de Fase 5, que registra estudio de comportamiento de
  terceros y una política declarada de “cero copia literal”. Esa declaración es
  evidencia de intención, no prueba suficiente de independencia.

No aparecieron encabezados de copyright ni identificadores de licencia de
terceros dentro de `src/mnemo` en el escaneo textual realizado. La ausencia de
marcadores tampoco demuestra que no exista una obligación o una similitud
expresiva relevante.

## Límites de la evidencia

- Un único autor visible en commits no demuestra origen de cada idea o línea.
- El agente que redacta este documento ya ha visto la implementación actual y
  notas históricas; por tanto, no puede actuar como único implementador
  “clean-room” y certificar independencia intelectual.
- No se hizo comparación forense contra repositorios de terceros.
- No se revisaron contratos laborales, cesiones, prompts, chats ni archivos no
  versionados.
- Solo una revisión humana/profesional puede decidir si hacen falta avisos,
  permisos adicionales, conservación de material o un proceso clean-room más
  estricto.

## Matriz de superficies

| Superficie actual | Evidencia observable | Riesgo | Disposición para Horiel |
|---|---|---:|---|
| `src/mnemo/json-store.ts`, `db.ts`, `scopes.ts`, `retrieval.ts`, `context.ts` | API JSON y semántica histórica del producto | Alto | No copiar ni renombrar. Extraer solo requisitos aprobados y reescribir desde una spec neutral. |
| `src/mnemo/engine/*` | Engine SQLite/FTS5 creado en los hitos `035e893`/`03dd1aa` | Alto | Tratar como evidencia *as-is*. No usar código, DDL, comentarios ni estructura como base literal de Horiel. |
| `src/mnemo/migration/*` | Migrador JSON→SQLite actual, hito `1e172f7` | Alto | No convertirlo en migrador Horiel. Diseñar una utilidad temporal nueva desde el formato neutral de entrada/salida. |
| `src/mnemo/admin*.ts`, `v2-tools.ts`, `tools.ts`, `tool-definitions.ts`, `index.ts` | Administración y transporte MCP actuales | Alto | Reescribir contratos y transporte; retirar nombres/aliases Mnemo del producto objetivo. |
| `src/mnemo/storage.ts`, `sanitizer.ts`, `hook-context.ts` | Selección de backend y controles transversales | Medio/alto | Reescribir detrás de puertos Horiel; se pueden conservar requisitos de seguridad genéricos, no implementación. |
| Tests `memory-*`, `mnemo-*` y fixtures | Codifican comportamiento y detalles del engine actual | Alto | No copiar cuerpos, fixtures, nombres ni expectativas. Crear tests nuevos desde criterios Horiel aprobados. |
| CLI `memory`, `context`, install/update/doctor/uninstall | Consumidores directos y ciclo de vida | Medio | Sustituir por adaptadores Horiel en una fase posterior; mantener el sistema actual activo hasta corte verificado. |
| Plugin OpenCode y configuración MCP `mnemo` | Registro runtime, detección y tool prefixes | Alto | Cambiar al servidor canónico `horiel`; no publicar aliases `mnemo_*`. |
| `package.json`, paths y bundle `dist/mnemo` | Artefactos públicos actuales | Alto | Retirar del paquete objetivo solo después de migrar ambas instalaciones y verificar rollback. |
| Assets, personas, skills, comandos y vault template | Lenguaje de producto distribuido | Medio | Reescribir referencias hacia Horiel; históricos se anotan, no se falsifican ni borran. |
| Notas PM/arquitectura en Obsidian | Decisiones y evidencias históricas | Medio | Conservar como historia *as-is* y declarar que Horiel es el target vigente. |
| `LICENSE` y `THIRD_PARTY_NOTICES.md` | Régimen propietario y avisos conocidos | Crítico | Preservar. Cualquier cambio de avisos depende de revisión humana/profesional. |

## Inventario fuente sujeto a disposición

### Núcleo y fachada actuales

- `src/mnemo/json-store.ts`
- `src/mnemo/db.ts`
- `src/mnemo/storage.ts`
- `src/mnemo/scopes.ts`
- `src/mnemo/retrieval.ts`
- `src/mnemo/context.ts`
- `src/mnemo/sanitizer.ts`

### MCP y administración actuales

- `src/mnemo/index.ts`
- `src/mnemo/tools.ts`
- `src/mnemo/tool-definitions.ts`
- `src/mnemo/v2-tools.ts`
- `src/mnemo/admin.ts`
- `src/mnemo/admin-backup.ts`
- `src/mnemo/admin-reset.ts`
- `src/mnemo/hook-context.ts`

### Engine SQLite actual

- `src/mnemo/engine/driver.ts`
- `src/mnemo/engine/errors.ts`
- `src/mnemo/engine/index.ts`
- `src/mnemo/engine/observations.ts`
- `src/mnemo/engine/paths.ts`
- `src/mnemo/engine/schema.ts`
- `src/mnemo/engine/store.ts`

### Migrador actual

- `src/mnemo/migration/files.ts`
- `src/mnemo/migration/index.ts`
- `src/mnemo/migration/inspection.ts`
- `src/mnemo/migration/locks.ts`
- `src/mnemo/migration/manifest.ts`
- `src/mnemo/migration/snapshot.ts`
- `src/mnemo/migration/types.ts`
- `src/mnemo/migration/verify.ts`

## Regla de construcción propuesta

1. Congelar la implementación actual como referencia operativa, no como fuente
   de Horiel.
2. Aprobar una especificación neutral basada solo en necesidades propias,
   invariantes de datos y controles de seguridad.
3. Entregar esa especificación a un implementador/revisor separado que no use
   `src/mnemo`, sus tests ni sus textos como material de trabajo.
4. Crear código, esquema, mensajes y tests nuevos; documentar decisiones y
   fuentes genéricas permitidas (por ejemplo, documentación oficial de Node y
   SQLite).
5. Comparar resultados mediante escenarios de caja negra propios, no mediante
   copia de fixtures ni paridad textual con el sistema anterior.
6. Mantener cualquier aviso legal que la revisión profesional determine.

## Gate de salida de procedencia

La Fase 1 técnica puede cerrar con este inventario y el SDD de Horiel, pero la
implementación queda en **NO-GO** hasta registrar:

- revisor humano/profesional y alcance de su revisión;
- decisión por cada grupo de archivos: reescritura, retiro, histórico o aviso;
- lista de fuentes permitidas para el equipo clean-room;
- confirmación sobre licencias/avisos y titularidad;
- aceptación explícita de la spec neutral que recibirá el implementador.

Hasta entonces no se crea `src/horiel`, no se renombra código existente y no se
migran instalaciones reales.
