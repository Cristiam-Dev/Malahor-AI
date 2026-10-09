# programming/architecture/microservices

## Usar Cuando

- Se evalua dividir servicios, diseñar comunicacion distribuida o evolucionar un monolito.

## Versiones y compatibilidad

- Microservicios son decision organizacional y operacional, no solo tecnica.
- Preferir modular monolith si el equipo no necesita despliegue/ownership independiente.

## Reglas canonicas sintetizadas

- Separar por capacidades de negocio y ownership de equipo, no por capas tecnicas.
- Cada servicio posee sus datos; compartir DB rompe autonomia.
- Diseñar para fallos: timeouts, retries con backoff, circuit breakers, bulkheads, idempotencia.
- Contratos versionados y compatibilidad hacia atras.
- Observabilidad obligatoria: logs estructurados, metricas RED/USE, tracing, correlation IDs.
- Consistencia distribuida: sagas/outbox/eventual consistency cuando no hay transaccion global.
- Automatizar build, test, deploy, rollback y security scanning.

## Anti-patrones

- Distribuir un monolito mal entendido.
- Microservicios para equipos pequenos sin madurez DevOps.
- Llamadas sincronicas en cadena sin timeouts.
- Sin tracing, ownership ni estrategia de datos.

## Validacion

- Justificar costo operacional vs modular monolith.
- Definir boundaries, contratos, datos y SLOs.
- Probar fallos de red, reintentos e idempotencia.

## Fuentes canonicas

- Martin Fowler, Microservices: https://martinfowler.com/articles/microservices.html
- Microsoft Cloud Architecture Center - Microservices: https://learn.microsoft.com/azure/architecture/guide/architecture-styles/microservices
- AWS Well-Architected Reliability: https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html
