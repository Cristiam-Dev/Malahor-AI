# programming/architecture/hexagonal-architecture

## Usar Cuando

- El dominio debe aislarse de frameworks, UI, bases de datos, APIs externas o proveedores.
- Hay necesidad real de testear reglas sin infraestructura o cambiar adaptadores.

## Versiones y compatibilidad

- Es patron arquitectonico canonico, no dependiente de framework.
- Aplicarlo de forma proporcional; no crear puertos ceremoniales en CRUD trivial.

## Reglas canonicas sintetizadas

- Dominio y casos de uso no dependen de infraestructura.
- Puertos expresan necesidades del dominio/aplicacion; adaptadores implementan detalles externos.
- Adaptadores primarios conducen el sistema (HTTP, CLI, eventos); adaptadores secundarios proveen recursos (DB, APIs, colas).
- DTOs externos no cruzan al dominio sin traduccion.
- Tests de dominio/casos de uso usan fakes/in-memory y verifican reglas, no framework.

## Anti-patrones

- Interfaces por cada clase sin variacion ni testabilidad real.
- Nombres tecnologicos en puertos (`JpaUserRepositoryPort`).
- Validaciones HTTP o annotations de framework en entidades puras.
- Adaptadores llamandose entre si y saltando casos de uso.

## Validacion

- Revisar direccion de imports: dominio/aplicacion no importan framework ni adapters.
- Casos de uso ejecutables en tests sin servidor ni DB real.
- Mappers explicitos en boundaries.

## Fuentes canonicas

- Alistair Cockburn, Hexagonal Architecture: https://alistair.cockburn.us/hexagonal-architecture/
- Martin Fowler, Application Architecture: https://martinfowler.com/architecture/
