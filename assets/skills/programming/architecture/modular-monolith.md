# programming/architecture/modular-monolith

## Usar Cuando

- Se necesita modularidad fuerte sin complejidad distribuida.
- El equipo quiere evolucionar hacia microservicios, pero aun no justifica red/despliegue independiente.

## Versiones y compatibilidad

- Patron independiente de stack; se implementa con packages/modules/bounded contexts internos.
- Puede convivir con hexagonal/clean architecture dentro de cada modulo.

## Reglas profesionales

- Modulos por capacidad de negocio, no por tipo tecnico global.
- APIs internas explicitas; imports entre modulos controlados.
- Ownership de datos por modulo aunque compartan base fisica.
- Eventos internos opcionales para desacoplar sin red.
- Tests por modulo y contract tests internos para boundaries.
- Preparar extraccion futura solo cuando el costo sea bajo y la necesidad probable.

## Anti-patrones

- Carpetas globales `controllers/services/repositories` como unica organizacion.
- Imports cruzados libres.
- DB compartida sin ownership logico.
- Pretender independencia operacional que no existe.

## Validacion

- Grafo de dependencias sin ciclos indebidos.
- Boundary tests y restricciones de imports si el lenguaje/tooling lo permite.
- Documentar ownership de modulo y datos.

## Fuentes canonicas

- Martin Fowler, MonolithFirst: https://martinfowler.com/bliki/MonolithFirst.html
- Modular Monolith discussion: https://martinfowler.com/articles/microservices.html#MonolithFirst
