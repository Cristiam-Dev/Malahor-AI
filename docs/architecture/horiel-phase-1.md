# Horiel — Fase 1: definición arquitectónica

**Estado:** propuesta técnica cerrada; implementación bloqueada por gates

**Fecha:** 2026-10-31

**Nivel SDD:** 2 (arquitectura, seguridad, persistencia y migración real futura)

## 1. Objetivo

Definir Horiel como el motor first-party de memoria de Malahor sin depender del
nombre, código, esquema, tests o comportamiento expresivo de Mnemo. La fase
produce requisitos y fronteras suficientes para planear una implementación
clean-room posterior; no escribe producción ni opera datos reales.

## 2. Decisiones vigentes

1. **Nombre canónico:** Horiel.
2. **Producto objetivo:** Mnemo desaparece de código distribuido, interfaces,
   assets, configuración y documentación vigente. Los históricos se conservan
   con contexto cuando corresponda.
3. **Sin aliases legacy:** el producto final no expone `mnemo_*` ni conserva un
   servidor MCP llamado `mnemo`.
4. **Jerarquía:** `proyecto/asignación/HU/área`; se omiten niveles inexistentes.
   No se agregan sprint, epic o task por defecto. Un scope no es una ACL.
5. **Runtime:** Node ya requerido por Malahor y transporte MCP por stdio. Horiel
   no exige permisos administrativos ni un binario adicional obligatorio.
6. **Plataformas objetivo:** Windows nativo, Windows+WSL, Linux y macOS como
   usuario estándar.
7. **Migración:** automática pero explícita, una instalación por vez, mediante
   utilidad first-party temporal separada de Horiel Core.
8. **Autoridad:** pins, ranking, fechas o relaciones no resuelven autoridad ni
   conflictos automáticamente.
9. **Datos reales:** esta fase no lee, abre, bloquea, copia ni migra ninguna de
   las dos instalaciones existentes.

## 3. No-objetivos de la Fase 1

- Crear `src/horiel` o modificar `src/mnemo`.
- Definir DDL tomando como base el esquema actual.
- Reutilizar tests, fixtures, mensajes o contratos literales del sistema actual.
- Ejecutar migraciones, instalar componentes o cambiar configuración.
- Construir TUI/GUI.
- Reanudar T-5.5.2.
- Certificar cumplimiento legal, bancario o independencia intelectual.

## 4. Ubiquitous language

| Término | Significado |
|---|---|
| `ScopePath` | Ruta jerárquica canónica; identifica contexto, no permisos. |
| `MemoryRecord` | Hecho persistido con identidad, tipo, contenido, tags y fecha. |
| `SessionCheckpoint` | Resumen de continuidad ligado a un scope. |
| `Pin` | Prioridad de recuperación; nunca autoridad. |
| `Relation` | Vínculo explícito entre registros; no arbitra conflictos. |
| `HorielStore` | Puerto de persistencia transaccional del dominio. |
| `HorielSnapshot` | Representación verificable para backup/export/import. |
| `MigrationRun` | Operación trazable y aislada para una instalación concreta. |

Los nombres son propios de esta especificación y no fijan aún tablas ni forma
de serialización.

## 5. Arquitectura objetivo

### 5.1 Horiel Core

Dominio sin dependencia de OpenCode, MCP, CLI o SQLite. Define invariantes y
casos de uso: guardar, obtener, buscar, recuperar contexto, resumir sesión,
listar árbol, pin/unpin, promover, mover, inspeccionar, exportar y administrar
con preview. Toda entrada textual pasa por límites y sanitización de secretos.

### 5.2 Puerto `HorielStore`

Contrato interno orientado a transacciones, snapshots e integridad. No expone
SQL ni objetos del runtime. La selección de storage es única: ningún consumidor
puede mantener un segundo escritor o fallback silencioso.

### 5.3 Adaptador SQLite

Usará la API SQLite disponible en el runtime Node soportado solo después de
probar versión, FTS, locking, backup y permisos en cada plataforma. Extensiones
dinámicas quedan deshabilitadas. La disponibilidad se verifica; nunca se infiere
solo por versión.

Ruta objetivo propuesta: `MALAHOR_HOME/horiel/`, con estado y backups privados.
No se reutilizan automáticamente `mnemo/` ni `memory/active.json`; el migrador
publicará el corte mediante un contrato Horiel nuevo y versionado.

### 5.4 Horiel MCP

Servidor first-party por stdio. ID canónico del servidor: `horiel`. Nombres
propuestos de tools: `memory_save`, `memory_get`, `memory_search`,
`memory_context`, `memory_brief`, `memory_session_summary`, `memory_tree`,
`memory_pin`, `memory_unpin`, `memory_promote`, `memory_move`,
`memory_inspect`, `memory_backup` y operaciones destructivas con preview.

No habrá aliases `mnemo_*`. El cambio es breaking y se coordinará en el mismo
corte con protocolo, agentes, assets, comandos y documentación.

### 5.5 Adaptadores Malahor

- CLI: conserva el concepto `malahor-ai memory`, respaldado por Horiel.
- Plugin: registra únicamente el servidor `horiel` y aplica guardrails.
- Contexto/compaction/eventos: consumen casos de uso Horiel, nunca SQLite.
- Doctor/install/update/uninstall: administran footprint y versión de Horiel.
- Obsidian: sigue siendo documentación humana opcional, no storage operativo.

### 5.6 Migrador temporal

Componente first-party separado del core y del runtime estable. Conoce formatos
de origen solo mediante especificaciones neutrales. No se carga en sesiones
normales ni permanece como alias de compatibilidad después de cerrar ambas
migraciones.

## 6. Contratos funcionales mínimos

- Identidades estables y no recicladas.
- Escrituras y contadores atómicos.
- Árbol de scopes delimitado; sin colisiones por prefijos vecinos.
- Herencia explícita y presupuesto sin truncar registros.
- Búsqueda literal segura; sintaxis de usuario no se interpola en FTS/SQL.
- Pins solo priorizan selección.
- Contradicciones se muestran al usuario; no se resuelven automáticamente.
- Backups verificables y restauración con preview/confirmación.
- Operaciones destructivas con hooks, impacto recalculado y backup previo.
- Errores no crean una base vacía ni activan otra fuente silenciosamente.

## 7. Seguridad y privacidad

- Directorios/archivos privados según capacidades del SO; POSIX 0700/0600 no se
  presenta como cifrado.
- Windows exige validación de ACL, reparse points, hardlinks y atomicidad; no se
  simulan garantías POSIX.
- No persistir secretos, tokens, passwords, llaves privadas ni PII innecesaria.
- Parámetros enlazados, límites de tamaño, profundidad, términos y presupuesto.
- Un único writer coordinado; estados corruptos, futuros o ambiguos fallan
  cerrados para mutaciones y conservan diagnóstico de lectura seguro.
- Auditoría minimizada sin payloads de memoria.
- Ninguna aprobación de plan sustituye approvals de datos o destructivas.

## 8. ADR pendiente: journal y concurrencia

La evidencia actual con Node 22.18.0/SQLite 3.50.2 no permite aceptar WAL como
default de Horiel. Queda prohibido trasladar esa decisión desde el engine actual.

Alternativas que debe probar la implementación en sandbox:

1. `journal_mode=DELETE` o `TRUNCATE`, `synchronous=FULL`, transacciones cortas y
   exclusión explícita de escritores.
2. Runtime Node con SQLite corregido y WAL, solo si pasa la matriz completa.
3. Otro adaptador embebido sin binario adicional, únicamente mediante nueva ADR.

Gate: bloqueo acotado, recuperación tras crash, backup consistente, ausencia de
sidecars huérfanos y lectura/escritura entre procesos en las cuatro plataformas.
Sin evidencia reproducible no hay decisión final ni implementación productiva.

## 9. Matriz de plataforma

| Plataforma | Baseline | Gates pendientes |
|---|---|---|
| Linux | Node de Malahor, stdio, home de usuario | journal elegido, crash, locks, permisos, FTS y backup |
| WSL | Igual que Linux, rutas Linux | procesos concurrentes, reinicio, interacción con host sin escribir fuera del home |
| Windows nativo | Node sin admin | ACL, reparse/hardlinks, antivirus locks, rename atómico, paths largos y backup |
| macOS | Node sin binario externo | SQLite/FTS real, Gatekeeper/noexec, locks, journal, permisos y backup |

La compatibilidad anunciada requiere ejecución real; descargar o compilar para
una plataforma no equivale a haberla probado.

## 10. Migración automática de las dos instalaciones

Cada instalación se trata como una operación independiente (`A` y `B`):

1. detectar origen/backend en solo lectura;
2. validar formato, ownership, permisos y ausencia de enlaces inseguros;
3. generar preview, fingerprint y conteos completos;
4. obtener consentimiento específico de esa instalación;
5. excluir escritores y releer el fingerprint;
6. crear backup privado y verificarlo;
7. transformar a staging Horiel sin activar;
8. comparar todos los registros, IDs, scopes, sesiones, tags, pins, fechas,
   aliases y contadores; registrar cualquier mapeo;
9. validar integridad, consultas, contexto, FTS y backup;
10. publicar el estado activo de forma atómica y desactivar el escritor legado;
11. comprobar escritura/relectura por MCP, CLI y contexto;
12. emitir informe sin secretos y conservar rollback verificable.

Resolver `A` no autoriza ni arranca `B`. No se fusionan bases, no se deduplican
recuerdos y no se migra durante `install`/`update` ordinario. Un fallo previo al
corte mantiene el origen activo; tras nuevas escrituras Horiel no se hace
rollback automático que pueda descartarlas.

## 11. Roadmap posterior por gates

1. **P0 — Procedencia:** revisión humana/profesional del inventario y fuentes
   permitidas. Resultado obligatorio: GO/NO-GO documentado.
2. **P1 — Contrato neutral:** aprobar casos de uso, formatos públicos,
   invariantes y criterios de aceptación sin usar código/tests actuales.
3. **P2 — Core clean-room:** dominio, puertos y tests nuevos.
4. **P3 — Store y journal:** adaptador + ADR resuelta con sandbox.
5. **P4 — MCP/CLI/plugin:** nombres Horiel y guardrails, sin aliases Mnemo.
6. **P5 — Migrador sandbox:** fixtures neutrales, fallos, reintentos y rollback.
7. **P6 — Portabilidad:** Windows/WSL/Linux/macOS sin admin.
8. **P7A/P7B — Corridas reales:** planes, backups y consentimientos separados.
9. **P8 — Retiro físico:** eliminar Mnemo del producto y verificar instalación
   limpia, update, uninstall, rollback y documentación.

T-5.5.2 permanece pausada. Su contenido se reevalúa después del contrato Horiel;
no se ejecuta como gate de una arquitectura que será reemplazada.

## 12. Aceptación de Fase 1

- [x] Nombre, alcance, jerarquía y no-objetivos definidos.
- [x] Fronteras Core/Store/MCP/CLI/plugin/migrador definidas.
- [x] Estrategia de dos instalaciones y no autoarranque definida.
- [x] Requisitos sin admin y matriz de plataformas definida.
- [x] WAL rechazado como default sin evidencia; ADR y gate explícitos.
- [x] Inventario preliminar de procedencia separado.
- [ ] Revisión humana/profesional de procedencia: **bloquea implementación**.
- [ ] Aprobación del contrato neutral y naming MCP por el usuario.
- [ ] ADR de journal respaldada por pruebas multiplataforma.

Conclusión: la definición técnica preliminar está cerrada. Horiel continúa en
**NO-GO de implementación** hasta resolver los tres últimos gates; no se toca
producción, instalaciones ni datos reales con esta fase.
