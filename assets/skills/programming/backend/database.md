# programming/backend/database

## Usar Cuando

- Esquemas, migraciones, indices, queries, transacciones, ORM o persistencia.

## Versiones y compatibilidad

- Ajustar recomendaciones al motor real: PostgreSQL, MySQL, SQL Server, MongoDB, Redis, etc.
- Baseline de referencias: PostgreSQL current docs para SQL relacional; ORM docs solo complementan, no reemplazan el motor.

## Reglas profesionales

- Migraciones versionadas, revisables y probadas; plan de rollback/backfill para cambios destructivos.
- Constraints en DB para invariantes criticas: unicidad, FK, check constraints, not null.
- Indices guiados por queries reales y `EXPLAIN`, no por intuicion.
- Transacciones alrededor de invariantes multi-write; definir isolation cuando importa concurrencia.
- Evitar N+1: revisar eager/lazy loading y query count en rutas criticas.
- Separar modelos de lectura/escritura solo si reduce complejidad real.
- Datos sensibles: cifrado/mascarado/retencion segun riesgo y regulacion.

## Anti-patrones

- Cambios destructivos sin backfill ni ventana de compatibilidad.
- Campos JSON para evitar modelar relaciones criticas.
- ORMs ocultando queries costosas.
- Migraciones no deterministas o dependientes del estado local.

## Validacion

- Tests de migracion en base limpia y con datos representativos.
- `EXPLAIN`/plan para queries criticas.
- Pruebas de concurrencia para invariantes sensibles.
- Backup/restore o rollback documentado en cambios de alto riesgo.

## Referencias oficiales

- PostgreSQL Docs: https://www.postgresql.org/docs/current/
- PostgreSQL Indexes: https://www.postgresql.org/docs/current/indexes.html
- PostgreSQL Transactions/MVCC: https://www.postgresql.org/docs/current/mvcc.html
- Prisma Docs: https://www.prisma.io/docs
- TypeORM Docs: https://typeorm.io/
